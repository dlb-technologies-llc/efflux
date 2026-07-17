/**
 * Self-contained Worker-side web_search client: queries DuckDuckGo's keyless HTML
 * SERP with a browser User-Agent, parses result anchors + snippets, unwraps
 * DuckDuckGo's `uddg` redirect wrapper, and returns a capped {title,url,snippet}
 * list. Never fails: every error (network, timeout, blocked/anomaly page,
 * unparseable HTML) collapses in-band to an empty list with the reason in `error`.
 */
import { Effect, Schema } from "effect"
import { causeMessage } from "./WebFetch.ts"

/** DuckDuckGo keyless HTML SERP endpoint. A browser UA APPEARS required — DDG serves an anomaly page to default fetch agents (confirm at the live worker; workerd may override the UA on egress). */
const DDG_ENDPOINT = "https://html.duckduckgo.com/html/"

/** Browser-like UA so DuckDuckGo returns the real SERP instead of a blocked/anomaly page (hypothesis — verified at Wave 2, not settled fact). */
const SEARCH_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

/** Cap on results returned to the model; bounds tool output fed back into the prompt. */
export const MAX_WEB_SEARCH_RESULTS = 8

/** Per-snippet character cap so one long result can't blow the prompt budget. */
const MAX_SNIPPET_CHARS = 500

/** Caps the already-buffered SERP string handed to the parser. NOTE: `response.text()` buffers the whole body first, so this bounds PARSE input, not the network read — a cheap guard on a pathological body, not a streaming ceiling. */
const MAX_SERP_BYTES = 200_000

/** One structured search hit the model can optionally hand to web_fetch. */
export const WebSearchItem = Schema.Struct({
  title: Schema.String,
  url: Schema.String,
  snippet: Schema.String,
})

/** web_search result: the hit list (possibly empty) plus an in-band `error` ("" on success). */
export const WebSearchResult = Schema.Struct({
  results: Schema.Array(WebSearchItem),
  error: Schema.String,
})

type WebSearchResultValue = typeof WebSearchResult.Type

/** In-band failure: empty results carrying the reason for the model to read (mirrors webFetchError). */
export const webSearchError = (message: string): WebSearchResultValue => ({
  results: [],
  error: `Error: ${message}`,
})

/** Matches DuckDuckGo's `/l/` redirect wrapper (protocol-relative or absolute) so only genuine wrappers are unwrapped. */
const DDG_REDIRECT = /^(?:https?:)?\/\/duckduckgo\.com\/l\/\?/

/** Extracts the percent-encoded `uddg` target from a DDG redirect query, tolerating `uddg` appearing after other params. */
const UDDG_PARAM = /[?&]uddg=([^&]*)/

/**
 * Endpoint-agnostic href normalizer: if `href` is a `//duckduckgo.com/l/?uddg=…`
 * (or `https://duckduckgo.com/l/?uddg=…`) wrapper, decode the `uddg` param and
 * return the target; otherwise return `href` unchanged. The passthrough branch
 * covers the `lite` endpoint's direct hrefs, so the same function is correct for
 * either endpoint. A wrapper missing the `uddg` param passes through unchanged;
 * a non-http target is returned decoded and dropped later by the caller.
 */
export const unwrapDdgUrl = (href: string): string => {
  if (!DDG_REDIRECT.test(href)) return href
  const match = href.match(UDDG_PARAM)
  if (match === null) return href
  const [, encoded] = match
  if (encoded === undefined) return href
  return decodeURIComponent(encoded)
}

/** The HTML entities DuckDuckGo emits in titles/snippets, mapped to their plain-text form. */
const HTML_ENTITIES: Readonly<Record<string, string>> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#x27;": "'",
  "&#39;": "'",
  "&nbsp;": " ",
}

/** Single-pass matcher for the {@link HTML_ENTITIES} keys. */
const ENTITY_PATTERN = /&(?:amp|lt|gt|quot|#x27|#39|nbsp);/g

/** Decode the common HTML entities DuckDuckGo emits so the model reads plain text. */
export const decodeEntities = (text: string): string =>
  text.replace(ENTITY_PATTERN, (entity) => HTML_ENTITIES[entity] ?? entity)

/** Matches any HTML tag so DDG's `<b>…</b>` highlighting (and any residual markup) can be removed. */
const TAG_PATTERN = /<[^>]*>/g

/** Strip DuckDuckGo's `<b>…</b>` highlighting and any residual tags from a fragment. */
export const stripTags = (html: string): string => html.replace(TAG_PATTERN, "")

/**
 * Matches one DuckDuckGo `html`-endpoint web result: the `result__a` title anchor
 * (opening-tag attributes + inner text) followed by its `result__snippet` anchor,
 * skipping the intervening `result__extras` icon/url anchors. Global for matchAll.
 */
const RESULT_ANCHOR =
  /<a\b([^>]*\bclass="result__a"[^>]*)>([\s\S]*?)<\/a>[\s\S]*?<a\b[^>]*\bclass="result__snippet"[^>]*>([\s\S]*?)<\/a>/g

/** Pulls the `href` value out of a captured anchor's attribute string, regardless of attribute order. */
const HREF_ATTR = /\bhref="([^"]*)"/

/** Keeps only final URLs the model can actually fetch (http/https); protocol-relative or other schemes are dropped. */
const HTTP_URL = /^https?:\/\//

/**
 * Parse a DuckDuckGo `html`-endpoint SERP into a capped, de-duplicated hit list.
 *
 * Selectors are tuned to the REAL `html.duckduckgo.com/html/` markup captured live
 * during implementation (`result__a` title anchors + `result__snippet` snippets);
 * the current endpoint serves direct hrefs (so {@link unwrapDdgUrl} passes them
 * through) though it historically wraps them in `uddg`. Each hit's href is run
 * through {@link unwrapDdgUrl}; its title/snippet through {@link stripTags} +
 * {@link decodeEntities} then trimmed; snippets are capped at
 * {@link MAX_SNIPPET_CHARS}. Entries with an empty title or non-http URL are
 * skipped, results are de-duplicated by final URL (DDG repeats URLs across hits),
 * and the list is capped at {@link MAX_WEB_SEARCH_RESULTS} AFTER dedup. Total and
 * pure: an anomaly page or empty string yields `[]` without throwing.
 */
export const parseResults = (
  html: string,
): ReadonlyArray<typeof WebSearchItem.Type> => {
  const items: Array<typeof WebSearchItem.Type> = []
  const seen = new Set<string>()
  for (const match of html.matchAll(RESULT_ANCHOR)) {
    const [, attrs, rawTitle, rawSnippet] = match
    if (
      attrs === undefined ||
      rawTitle === undefined ||
      rawSnippet === undefined
    ) {
      continue
    }
    const hrefMatch = attrs.match(HREF_ATTR)
    if (hrefMatch === null) continue
    const [, rawHref] = hrefMatch
    if (rawHref === undefined) continue
    const url = unwrapDdgUrl(rawHref)
    if (!HTTP_URL.test(url)) continue
    const title = decodeEntities(stripTags(rawTitle)).trim()
    if (title.length === 0) continue
    if (seen.has(url)) continue
    seen.add(url)
    const snippet = decodeEntities(stripTags(rawSnippet))
      .trim()
      .slice(0, MAX_SNIPPET_CHARS)
    items.push({ title, url, snippet })
    if (items.length >= MAX_WEB_SEARCH_RESULTS) break
  }
  return items
}

/** Query DuckDuckGo's keyless HTML SERP and return up to MAX_WEB_SEARCH_RESULTS parsed hits; all failures collapse to an in-band empty result with the reason in `error`. */
export const runWebSearch = (query: string): Effect.Effect<WebSearchResultValue> =>
  Effect.gen(function* () {
    const trimmed = query.trim()
    if (trimmed.length === 0) return webSearchError("empty query")
    const url = `${DDG_ENDPOINT}?q=${encodeURIComponent(trimmed)}`
    const response = yield* Effect.tryPromise((signal) =>
      fetch(url, { headers: { "user-agent": SEARCH_USER_AGENT }, signal }),
    )
    if (!response.ok) {
      return webSearchError(`search endpoint returned status ${response.status}`)
    }
    const html = (yield* Effect.tryPromise(() => response.text())).slice(
      0,
      MAX_SERP_BYTES,
    )
    return { results: parseResults(html), error: "" }
  }).pipe(
    Effect.timeout("15 seconds"),
    Effect.catchCause((cause) => Effect.succeed(webSearchError(causeMessage(cause)))),
  )
