/**
 * Self-contained Worker-side web_search client: queries DuckDuckGo's keyless HTML
 * SERP via a form POST (the `html` endpoint challenges GET with an anomaly page),
 * parses result anchors + snippets, unwraps DuckDuckGo's `uddg` redirect wrapper,
 * and returns a capped {title,url,snippet} list. Never fails: every error (network,
 * timeout, blocked/anomaly page, unparseable HTML) collapses in-band to an empty
 * list with the reason in `error`.
 */
import { Effect, Schema } from "effect"
import { causeMessage, readBody } from "./WebFetch.ts"

/** DuckDuckGo keyless HTML SERP endpoint. Queried by form POST + a browser UA: a GET (or a default fetch UA) is served an anomaly/challenge page with no results. */
const DDG_ENDPOINT = "https://html.duckduckgo.com/html/"

/** Browser-like UA so DuckDuckGo returns the real SERP instead of a blocked/anomaly page. */
const SEARCH_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

/** Cap on results returned to the model; bounds tool output fed back into the prompt. */
export const MAX_WEB_SEARCH_RESULTS = 8

/** Per-snippet character cap so one long result can't blow the prompt budget. */
const MAX_SNIPPET_CHARS = 500

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
 * either endpoint. A wrapper missing the `uddg` param — or one whose param is
 * malformed percent-encoding (`decodeURIComponent` would throw) — passes through
 * unchanged rather than throwing, so a single bad href can't collapse the search;
 * a non-http target is returned decoded and dropped later by the caller.
 */
export const unwrapDdgUrl = (href: string): string => {
  if (!DDG_REDIRECT.test(href)) return href
  const match = href.match(UDDG_PARAM)
  if (match === null) return href
  const [, encoded] = match
  if (encoded === undefined) return href
  try {
    return decodeURIComponent(encoded)
  } catch {
    return href
  }
}

/** Named HTML entities DuckDuckGo emits that are not simple numeric references, mapped to plain text. */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
}

/** Matches a numeric (`&#8217;` / `&#x27;`) or named (`&amp;`) HTML entity. */
const ENTITY_PATTERN = /&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g

/** Decode the HTML entities DuckDuckGo emits — named plus arbitrary numeric references (smart quotes, em/en dashes) — so the model reads plain text; an unknown/out-of-range entity is left verbatim. */
export const decodeEntities = (text: string): string =>
  text.replace(ENTITY_PATTERN, (whole: string, body: string): string => {
    if (body.startsWith("#")) {
      const codePoint =
        body.startsWith("#x") || body.startsWith("#X")
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10)
      if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
        return whole
      }
      return String.fromCodePoint(codePoint)
    }
    return NAMED_ENTITIES[body] ?? whole
  })

/** Matches any HTML tag so DDG's `<b>…</b>` highlighting (and any residual markup) can be removed. */
const TAG_PATTERN = /<[^>]*>/g

/** Strip DuckDuckGo's `<b>…</b>` highlighting and any residual tags from a fragment. */
export const stripTags = (html: string): string => html.replace(TAG_PATTERN, "")

/**
 * Matches one DuckDuckGo `result__a` title anchor (opening-tag attributes + inner
 * text), tolerant of extra modifier classes in the `class` attribute. Global for
 * matchAll: each match anchors one result, and the snippet is sought in the span
 * up to the NEXT title so a snippet-less result can't steal the next one's snippet.
 */
const TITLE_ANCHOR =
  /<a\b([^>]*\bclass="[^"]*\bresult__a\b[^"]*"[^>]*)>([\s\S]*?)<\/a>/g

/** Matches the first `result__snippet` anchor within a single result's span (tolerant of modifier classes); a result with none yields an empty snippet. */
const SNIPPET_ANCHOR =
  /<a\b[^>]*\bclass="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/a>/

/** Pulls the `href` value out of a captured anchor's attribute string, regardless of attribute order. */
const HREF_ATTR = /\bhref="([^"]*)"/

/** Keeps only final URLs the model can actually fetch (http/https); protocol-relative or other schemes are dropped. */
const HTTP_URL = /^https?:\/\//

/**
 * Parse a DuckDuckGo `html`-endpoint SERP into a capped, de-duplicated hit list.
 *
 * Selectors are tuned to the REAL `html.duckduckgo.com/html/` markup captured live
 * during implementation (`result__a` title anchors + `result__snippet` snippets),
 * matched by word-bounded class so a modifier class (`result__a result__a--ad`)
 * still parses. Each title's snippet is sought only in the span up to the NEXT
 * title, so a snippet-less result yields an empty snippet instead of mis-pairing
 * with — and dropping — the following result. Each hit's href is entity-decoded and
 * run through {@link unwrapDdgUrl}; its title/snippet through {@link stripTags} +
 * {@link decodeEntities} then trimmed; snippets are capped at {@link MAX_SNIPPET_CHARS}.
 * Entries with an empty title or non-http URL are skipped, results are de-duplicated
 * by final URL (DDG repeats URLs across hits), and the list is capped at
 * {@link MAX_WEB_SEARCH_RESULTS} AFTER dedup. Total and pure: an anomaly page or
 * empty string yields `[]` without throwing.
 */
export const parseResults = (
  html: string,
): ReadonlyArray<typeof WebSearchItem.Type> => {
  const titles = [...html.matchAll(TITLE_ANCHOR)]
  const items: Array<typeof WebSearchItem.Type> = []
  const seen = new Set<string>()
  for (let i = 0; i < titles.length; i++) {
    const match = titles[i]
    if (match === undefined || match.index === undefined) continue
    const [whole, attrs, rawTitle] = match
    if (whole === undefined || attrs === undefined || rawTitle === undefined) {
      continue
    }
    const hrefMatch = attrs.match(HREF_ATTR)
    if (hrefMatch === null) continue
    const [, rawHref] = hrefMatch
    if (rawHref === undefined) continue
    const url = decodeEntities(unwrapDdgUrl(rawHref))
    if (!HTTP_URL.test(url)) continue
    const title = decodeEntities(stripTags(rawTitle)).trim()
    if (title.length === 0) continue
    if (seen.has(url)) continue
    const blockStart = match.index + whole.length
    const next = titles[i + 1]
    const blockEnd =
      next !== undefined && next.index !== undefined ? next.index : html.length
    const snippetMatch = html.slice(blockStart, blockEnd).match(SNIPPET_ANCHOR)
    const rawSnippet = snippetMatch?.[1] ?? ""
    const snippet = decodeEntities(stripTags(rawSnippet))
      .trim()
      .slice(0, MAX_SNIPPET_CHARS)
    seen.add(url)
    items.push({ title, url, snippet })
    if (items.length >= MAX_WEB_SEARCH_RESULTS) break
  }
  return items
}

/** DuckDuckGo's HTTP-200 anomaly/challenge page carries none of these markers on a real SERP; used to turn a zero-result block into an explicit rate-limited error rather than a silent "no matches". */
const ANOMALY_MARKER =
  /challenge-form|anomaly-modal|are you (?:a )?(?:human|robot)|unusual traffic/i

/** Query DuckDuckGo's keyless HTML SERP (form POST) and return up to MAX_WEB_SEARCH_RESULTS parsed hits; a zero-result anomaly page becomes an explicit error, and all failures collapse to an in-band empty result with the reason in `error`. */
export const runWebSearch = (query: string): Effect.Effect<WebSearchResultValue> =>
  Effect.gen(function* () {
    const trimmed = query.trim()
    if (trimmed.length === 0) return webSearchError("empty query")
    const response = yield* Effect.tryPromise((signal) =>
      fetch(DDG_ENDPOINT, {
        method: "POST",
        headers: {
          "user-agent": SEARCH_USER_AGENT,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: `q=${encodeURIComponent(trimmed)}`,
        signal,
      }),
    )
    if (!response.ok) {
      return webSearchError(`search endpoint returned status ${response.status}`)
    }
    const { text: html } = yield* readBody(response)
    const results = parseResults(html)
    if (results.length === 0 && ANOMALY_MARKER.test(html)) {
      return webSearchError(
        "DuckDuckGo returned an anomaly/blocked page (rate-limited) — try again later",
      )
    }
    return { results, error: "" }
  }).pipe(
    Effect.timeout("15 seconds"),
    Effect.catchCause((cause) => Effect.succeed(webSearchError(causeMessage(cause)))),
  )
