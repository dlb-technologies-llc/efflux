/**
 * Table tests for the web_search parse + in-band-error surface: `webSearchError`
 * wraps a reason into the empty-result value, `unwrapDdgUrl` normalizes DDG's
 * `uddg` redirect wrapper, `decodeEntities` renders HTML entities as plain text,
 * and `parseResults` extracts a capped, de-duplicated {title,url,snippet} list
 * from REAL `html.duckduckgo.com/html/` SERP markup captured during implementation.
 *
 * @module
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import {
  decodeEntities,
  MAX_WEB_SEARCH_RESULTS,
  parseResults,
  unwrapDdgUrl,
  webSearchError,
} from "./WebSearch.ts"

/**
 * One REAL result captured from `html.duckduckgo.com/html/?q=cats & dogs comparison`
 * (whitespace collapsed, tags/attributes/text verbatim). Includes the intervening
 * `result__extras` icon + url anchors and `&#x27;` entities + `<b>` highlighting so
 * the parser's anchor-skipping, entity decode, and tag strip are all exercised.
 */
const REAL_RESULT_HTML =
  '<div class="result results_links results_links_deep web-result "> <div class="links_main links_deep result__body"> <!-- This is the visible part --> <h2 class="result__title"> <a rel="nofollow" class="result__a" href="https://www.sciencefocus.com/nature/cats-v-dogs-heres-whos-smarter-according-to-science">Cats v dogs: Here&#x27;s who&#x27;s smarter, according to science</a> </h2> <div class="result__extras"> <div class="result__extras__url"> <span class="result__icon"> <a rel="nofollow" href="https://www.sciencefocus.com/nature/cats-v-dogs-heres-whos-smarter-according-to-science"> <img class="result__icon__img" width="16" height="16" alt="" src="//external-content.duckduckgo.com/ip3/www.sciencefocus.com.ico" name="i15" /> </a> </span> <a class="result__url" href="https://www.sciencefocus.com/nature/cats-v-dogs-heres-whos-smarter-according-to-science"> www.sciencefocus.com/nature/cats-v-dogs-heres-whos-smarter-according-to-science </a> <span>&nbsp; &nbsp; 2025-08-26T00:00:00.0000000</span> </div> </div> <a class="result__snippet" href="https://www.sciencefocus.com/nature/cats-v-dogs-heres-whos-smarter-according-to-science">There&#x27;s more research on canines than felines, so <b>dogs&#x27;</b> abilities are better known. And, of course, studying pet <b>cats</b> is hard because they don&#x27;t like to go to new places, like a laboratory for example (think of how they hide whenever the <b>cat</b> carrier comes out).</a> <div class="clear"></div> </div> </div>'

/** The single {title,url,snippet} hit {@link REAL_RESULT_HTML} parses to, entities decoded and `<b>` stripped. */
const REAL_RESULT_ITEM = {
  title: "Cats v dogs: Here's who's smarter, according to science",
  url: "https://www.sciencefocus.com/nature/cats-v-dogs-heres-whos-smarter-according-to-science",
  snippet:
    "There's more research on canines than felines, so dogs' abilities are better known. And, of course, studying pet cats is hard because they don't like to go to new places, like a laboratory for example (think of how they hide whenever the cat carrier comes out).",
}

/**
 * NINE REAL result anchor pairs captured from the same `html` SERP (minimal real
 * wrappers, anchors verbatim) — one more than {@link MAX_WEB_SEARCH_RESULTS} so the
 * cap is exercised. Direct hrefs (the current endpoint's shape).
 */
const MANY_RESULTS_HTML = `<div class="result results_links results_links_deep web-result "><h2 class="result__title"><a rel="nofollow" class="result__a" href="https://www.diffen.com/difference/Cat_vs_Dog">Cat vs Dog - Difference and Comparison | Diffen</a></h2><a class="result__snippet" href="https://www.diffen.com/difference/Cat_vs_Dog"><b>Cat</b> vs <b>Dog</b> <b>comparison</b>. <b>Cats</b> and <b>dogs</b> are the most popular pets in the world. <b>Cats</b> are more independent and are generally cheaper and less demanding pets. <b>Dogs</b> are loyal and obedient but require more attention and exercise, including regular walks. How to choose When choosing b...</a></div>
<div class="result results_links results_links_deep web-result "><h2 class="result__title"><a rel="nofollow" class="result__a" href="https://sciencesensei.com/dogs-vs-cats-the-ultimate-battle-decided-by-28-scientific-studies/">Dogs vs Cats: The Ultimate Battle Decided by 28 Scientific Studies</a></h2><a class="result__snippet" href="https://sciencesensei.com/dogs-vs-cats-the-ultimate-battle-decided-by-28-scientific-studies/">For centuries, <b>dogs</b> and <b>cats</b> have vied for the title of humanity&#x27;s favorite companion. Families, friends, and even scientists have long debated which species truly reigns supreme. But what if the answer could be found through rigorous scientific research? In this article, we dive into 28 peer-reviewed studies that offer insights into every aspect of the debate—from health benefits and ...</a></div>
<div class="result results_links results_links_deep web-result "><h2 class="result__title"><a rel="nofollow" class="result__a" href="https://tica.org/blogs/the-great-debate-cats-vs-dogs/">The Great Debate: Cats vs. Dogs — Exploring the Age-Old Rivalry</a></h2><a class="result__snippet" href="https://tica.org/blogs/the-great-debate-cats-vs-dogs/">Discover the unique qualities of <b>cats</b> and <b>dogs</b> in the ultimate pet debate. Learn what makes each a great companion and find out which pet is best suited for your lifestyle.</a></div>
<div class="result results_links results_links_deep web-result "><h2 class="result__title"><a rel="nofollow" class="result__a" href="https://discover.hubpages.com/animals/Dogs-vs-Cats-Is-One-Really-Better-Than-the-Other">Cats vs. Dogs, a Comprehensive Comparison - HubPages</a></h2><a class="result__snippet" href="https://discover.hubpages.com/animals/Dogs-vs-Cats-Is-One-Really-Better-Than-the-Other">It&#x27;s a classic debate: <b>dogs</b> vs <b>cats</b>. In this article, we explore the key differences between these popular pets, including their unique personalities, social behaviors, and physical characteristics, to help you decide which one is right for you.</a></div>
<div class="result results_links results_links_deep web-result "><h2 class="result__title"><a rel="nofollow" class="result__a" href="https://animaldifferences.com/difference-between-dog-and-cat/">13 Difference Between Dog and Cat (With Table)</a></h2><a class="result__snippet" href="https://animaldifferences.com/difference-between-dog-and-cat/">What is the difference between <b>Dog</b> and <b>Cat</b>? <b>Dogs</b> and <b>cats</b> are the most common pet in the world. <b>Cats</b> are independent while <b>dogs</b> require much attention and exercise.</a></div>
<div class="result results_links results_links_deep web-result "><h2 class="result__title"><a rel="nofollow" class="result__a" href="https://rexipets.com/blogs/the-latest/10-differences-between-cats-and-dogs">10 Differences Between Cats and Dogs - RexiPets</a></h2><a class="result__snippet" href="https://rexipets.com/blogs/the-latest/10-differences-between-cats-and-dogs">Discover the fascinating differences between <b>cats</b> and <b>dogs</b> in behavior, temperament, and more. Explore the unique traits of these beloved pets in our insightful <b>comparison</b>.</a></div>
<div class="result results_links results_links_deep web-result "><h2 class="result__title"><a rel="nofollow" class="result__a" href="https://dogsbestlife.com/dog-fun/dogs-or-cats/">Dogs or cats: Use size, lifespan, exercise needs, to choose</a></h2><a class="result__snippet" href="https://dogsbestlife.com/dog-fun/dogs-or-cats/"><b>Dogs</b> or <b>cats</b>? Discover why <b>dogs</b> are the ultimate pet and read trivia about <b>dogs</b>. Compare <b>cats</b> vs. <b>dogs</b>, and learn about popular <b>dog</b> breeds.</a></div>
<div class="result results_links results_links_deep web-result "><h2 class="result__title"><a rel="nofollow" class="result__a" href="https://www.sciencefocus.com/nature/cats-v-dogs-heres-whos-smarter-according-to-science">Cats v dogs: Here&#x27;s who&#x27;s smarter, according to science</a></h2><a class="result__snippet" href="https://www.sciencefocus.com/nature/cats-v-dogs-heres-whos-smarter-according-to-science">There&#x27;s more research on canines than felines, so <b>dogs&#x27;</b> abilities are better known. And, of course, studying pet <b>cats</b> is hard because they don&#x27;t like to go to new places, like a laboratory for example (think of how they hide whenever the <b>cat</b> carrier comes out).</a></div>
<div class="result results_links results_links_deep web-result "><h2 class="result__title"><a rel="nofollow" class="result__a" href="https://www.dogweave.com/academy/dogs-vs-cats-comparison">Dogs vs Cats: 12 Surprising Differences Every Pet Lover Should Know</a></h2><a class="result__snippet" href="https://www.dogweave.com/academy/dogs-vs-cats-comparison"><b>Dogs</b> or <b>cats</b>? We break down temperament, care, loyalty, health, and more in this ultimate head-to-head guide.</a></div>`

/** First {title,url,snippet} hit {@link MANY_RESULTS_HTML} parses to, `<b>` stripped. */
const MANY_RESULTS_FIRST_ITEM = {
  title: "Cat vs Dog - Difference and Comparison | Diffen",
  url: "https://www.diffen.com/difference/Cat_vs_Dog",
  snippet:
    "Cat vs Dog comparison. Cats and dogs are the most popular pets in the world. Cats are more independent and are generally cheaper and less demanding pets. Dogs are loyal and obedient but require more attention and exercise, including regular walks. How to choose When choosing b...",
}

/**
 * Two blocks using the REAL `result__a`/`result__snippet` selectors but with the
 * documented DDG `uddg` redirect href format (the current endpoint serves direct
 * hrefs, so no live capture exercises the unwrap path): the http target is
 * unwrapped + entity-decoded, the ftp target is dropped as non-http.
 */
const UDDG_RESULTS_HTML = `<div class="result results_links results_links_deep web-result "><h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Freal.example.com%2Fpage%3Fa%3D1%26b%3D2&rut=abc">Wrapped Result</a></h2><a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Freal.example.com%2Fpage">A <b>wrapped</b> hit &amp; its snippet.</a></div><div class="result results_links results_links_deep web-result "><h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=ftp%3A%2F%2Ffiles.example.com%2Fx">Ftp Result</a></h2><a class="result__snippet">Dropped because non-http.</a></div>`

/** The single hit {@link UDDG_RESULTS_HTML} parses to: uddg unwrapped, `&amp;` decoded, `<b>` stripped, ftp entry dropped. */
const UDDG_RESULTS_ITEM = {
  title: "Wrapped Result",
  url: "https://real.example.com/page?a=1&b=2",
  snippet: "A wrapped hit & its snippet.",
}

/** A REAL captured snippet body (verbatim) repeated so the decoded snippet exceeds the per-snippet cap. */
const REAL_SNIPPET_INNER =
  "There&#x27;s more research on canines than felines, so <b>dogs&#x27;</b> abilities are better known. And, of course, studying pet <b>cats</b> is hard because they don&#x27;t like to go to new places, like a laboratory for example (think of how they hide whenever the <b>cat</b> carrier comes out)."

/** One real result whose snippet body is tripled, so parseResults must truncate it to the cap. */
const OVERLONG_SNIPPET_HTML = `<div class="result results_links results_links_deep web-result "><h2 class="result__title"><a rel="nofollow" class="result__a" href="https://www.sciencefocus.com/nature/cats-v-dogs-heres-whos-smarter-according-to-science">Overlong snippet</a></h2><a class="result__snippet">${REAL_SNIPPET_INNER}${REAL_SNIPPET_INNER}${REAL_SNIPPET_INNER}</a></div>`

/**
 * Two blocks where the FIRST result has no `result__snippet` anchor. Guards the
 * mispair/drop regression: the snippet-less first result must keep an empty
 * snippet and the second result must survive with its own snippet.
 */
const MISSING_SNIPPET_HTML = `<div class="result"><h2 class="result__title"><a class="result__a" href="https://a.example.com/">Alpha</a></h2></div><div class="result"><h2 class="result__title"><a class="result__a" href="https://b.example.com/">Beta</a></h2><a class="result__snippet" href="https://b.example.com/">Beta snippet.</a></div>`

/** The two hits {@link MISSING_SNIPPET_HTML} parses to: Alpha with an empty snippet, Beta intact. */
const MISSING_SNIPPET_ITEMS = [
  { title: "Alpha", url: "https://a.example.com/", snippet: "" },
  { title: "Beta", url: "https://b.example.com/", snippet: "Beta snippet." },
]

/** A result whose `result__a`/`result__snippet` carry extra modifier classes — must still parse (word-bounded class match). */
const MODIFIER_CLASS_HTML = `<div class="result"><h2><a class="result__a result__a--ad" href="https://mod.example.com/">Modified</a></h2><a class="result__snippet result__snippet--x" href="https://mod.example.com/">Mod snippet.</a></div>`

/** The single hit {@link MODIFIER_CLASS_HTML} parses to. */
const MODIFIER_CLASS_ITEM = {
  title: "Modified",
  url: "https://mod.example.com/",
  snippet: "Mod snippet.",
}

/** A direct href whose query string is HTML-escaped (`&amp;`) — the returned URL must be entity-decoded so web_fetch parses it correctly. */
const ENTITY_HREF_HTML = `<div class="result"><h2><a class="result__a" href="https://site.example.com/?a=1&amp;b=2">Amp Href</a></h2><a class="result__snippet" href="x">Snip.</a></div>`

/** The single hit {@link ENTITY_HREF_HTML} parses to, with `&amp;` decoded in the URL. */
const ENTITY_HREF_ITEM = {
  title: "Amp Href",
  url: "https://site.example.com/?a=1&b=2",
  snippet: "Snip.",
}

/** The per-snippet character cap declared privately in WebSearch.ts. */
const MAX_SNIPPET_CHARS = 500

describe("webSearchError", () => {
  it.effect("wraps the reason as an empty in-band result", () =>
    Effect.sync(() =>
      expect(webSearchError("x")).toStrictEqual({
        results: [],
        error: "Error: x",
      })))
})

interface UnwrapCase {
  readonly label: string
  readonly href: string
  readonly expected: string
}

const unwrapCases: ReadonlyArray<UnwrapCase> = [
  {
    label: "protocol-relative uddg wrapper → decoded target",
    href: "//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage%3Fa%3D1%26b%3D2&rut=abc123",
    expected: "https://example.com/page?a=1&b=2",
  },
  {
    label: "absolute https uddg wrapper → decoded target",
    href: "https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2F",
    expected: "https://example.org/",
  },
  {
    label: "plain https href → unchanged (lite-endpoint direct href)",
    href: "https://effect.website/",
    expected: "https://effect.website/",
  },
  {
    label: "uddg wrapper with a non-http target → decoded (caller drops it)",
    href: "//duckduckgo.com/l/?uddg=ftp%3A%2F%2Ffiles.example.com%2Fx",
    expected: "ftp://files.example.com/x",
  },
  {
    label: "l/ redirect missing the uddg param → unchanged",
    href: "//duckduckgo.com/l/?rut=xyz",
    expected: "//duckduckgo.com/l/?rut=xyz",
  },
  {
    label: "uddg wrapper with malformed percent-encoding → unchanged (no throw)",
    href: "//duckduckgo.com/l/?uddg=%E0%A4%A&rut=z",
    expected: "//duckduckgo.com/l/?uddg=%E0%A4%A&rut=z",
  },
]

describe("unwrapDdgUrl", () => {
  for (const { label, href, expected } of unwrapCases) {
    it.effect(label, () =>
      Effect.sync(() => expect(unwrapDdgUrl(href)).toBe(expected)))
  }
})

interface DecodeCase {
  readonly label: string
  readonly text: string
  readonly expected: string
}

const decodeCases: ReadonlyArray<DecodeCase> = [
  {
    label: "amp + apostrophe entities",
    text: "a &amp; b &#x27;c&#x27;",
    expected: "a & b 'c'",
  },
  {
    label: "angle, quote, decimal-apostrophe, nbsp entities",
    text: "&lt;tag&gt; &quot;q&quot; &#39;a&#39; x&nbsp;y",
    expected: "<tag> \"q\" 'a' x y",
  },
  {
    label: "numeric decimal reference + named typographic entity",
    text: "it&#8217;s a cat&mdash;dog debate",
    expected: "it’s a cat—dog debate",
  },
  {
    label: "unknown named entity and out-of-range numeric entity → left verbatim",
    text: "a &bogus; b &#1114112;",
    expected: "a &bogus; b &#1114112;",
  },
]

describe("decodeEntities", () => {
  for (const { label, text, expected } of decodeCases) {
    it.effect(label, () =>
      Effect.sync(() => expect(decodeEntities(text)).toBe(expected)))
  }
})

describe("parseResults", () => {
  it.effect("parses a real html-endpoint block: unwrapped, decoded, stripped", () =>
    Effect.sync(() =>
      expect(parseResults(REAL_RESULT_HTML)).toStrictEqual([REAL_RESULT_ITEM])))

  it.effect("caps at MAX_WEB_SEARCH_RESULTS and bounds every snippet", () =>
    Effect.sync(() => {
      const results = parseResults(MANY_RESULTS_HTML)
      expect(results).toHaveLength(MAX_WEB_SEARCH_RESULTS)
      expect(results[0]).toStrictEqual(MANY_RESULTS_FIRST_ITEM)
      for (const { snippet } of results) {
        expect(snippet.length).toBeLessThanOrEqual(MAX_SNIPPET_CHARS)
      }
    }))

  it.effect("de-duplicates by final URL (DDG repeats hits)", () =>
    Effect.sync(() =>
      expect(
        parseResults(`${REAL_RESULT_HTML}${REAL_RESULT_HTML}`),
      ).toStrictEqual([REAL_RESULT_ITEM])))

  it.effect("unwraps uddg hrefs and drops non-http results", () =>
    Effect.sync(() =>
      expect(parseResults(UDDG_RESULTS_HTML)).toStrictEqual([
        UDDG_RESULTS_ITEM,
      ])))

  it.effect("a snippet-less result keeps an empty snippet and does not drop the next", () =>
    Effect.sync(() =>
      expect(parseResults(MISSING_SNIPPET_HTML)).toStrictEqual(
        MISSING_SNIPPET_ITEMS,
      )))

  it.effect("parses result anchors carrying extra modifier classes", () =>
    Effect.sync(() =>
      expect(parseResults(MODIFIER_CLASS_HTML)).toStrictEqual([
        MODIFIER_CLASS_ITEM,
      ])))

  it.effect("entity-decodes the result URL so an escaped href is usable", () =>
    Effect.sync(() =>
      expect(parseResults(ENTITY_HREF_HTML)).toStrictEqual([ENTITY_HREF_ITEM])))

  it.effect("truncates an overlong snippet at MAX_SNIPPET_CHARS", () =>
    Effect.sync(() => {
      const [only] = parseResults(OVERLONG_SNIPPET_HTML)
      expect(only?.snippet.length).toBe(MAX_SNIPPET_CHARS)
    }))

  it.effect("returns [] for empty input without throwing", () =>
    Effect.sync(() => expect(parseResults("")).toStrictEqual([])))

  it.effect("returns [] for an anomaly / no-results page without throwing", () =>
    Effect.sync(() =>
      expect(parseResults("<html>anomaly / no results</html>")).toStrictEqual(
        [],
      )))
})
