import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { installDom, isWellFormedXml, xmlParseError } from "../helpers/dom.js";
import { disableSleeps } from "../helpers/fakeNetwork.js";

before(() => { installDom({ url: "https://example.com/novel/chapter-1/" }); });

const { Parser } = await import("../../core/Parser.js");
const { Util } = await import("../../core/Util.js");

let restoreSleeps;
before(() => { restoreSleeps = disableSleeps(); });
after(() => { restoreSleeps?.(); });

/** Minimal concrete parser: content lives in #story. */
class StoryParser extends Parser {
  constructor(options = {}) {
    super({ name: "Story", ...options });
  }
  async getChapterList() { return []; }
  findContent(dom) { return dom.querySelector("#story"); }
}

const DIRTY_HTML = `<!doctype html><html><head>
  <meta property="og:title" content="A Story"/>
  <meta property="og:site_name" content="Example"/>
  <meta name="description" content="A short description."/>
  <title>Fallback Title</title>
  </head><body>
  <div id="story">
    <h1>Chapter 3 - Middle</h1>
    <p>First paragraph.</p>
    <script>evil()</script>
    <style>.x{}</style>
    <noscript>no js</noscript>
    <button>click</button>
    <iframe src="https://ads.test/"></iframe>
    <div aria-hidden="true">hidden</div>
    <!-- a comment -->
    <p>Second   paragraph.</p>
    <img data-src="https://cdn.test/real.png" src="https://cdn.test/tiny.png" srcset="a 1x, b 2x" alt="pic"/>
    <div class="ad">buy things</div>
    <div class="site-clutter">newsletter</div>
    <div class="empty"></div>
    <div class="keep">Real text.</div>
  </div>
</body></html>`;

function parse() {
  return Util.parseHtml(DIRTY_HTML);
}

describe("Parser metadata defaults", () => {
  const parser = new StoryParser();

  test("extractTitle prefers og:title", () => {
    assert.equal(parser.extractTitle(parse()), "A Story");
  });

  test("extractTitle falls back to the document title", () => {
    const dom = Util.parseHtml("<html><head><title>Only Title</title></head><body></body></html>");
    assert.equal(parser.extractTitle(dom), "Only Title");
  });

  test("extractAuthor defaults to empty", () => {
    assert.equal(parser.extractAuthor(parse()), "");
  });

  test("extractPublisher uses og:site_name", () => {
    assert.equal(parser.extractPublisher(parse()), "Example");
  });

  test("extractDescription uses the meta description", () => {
    assert.equal(parser.extractDescription(parse()), "A short description.");
  });

  test("extractLanguage reads the html lang attribute", () => {
    const dom = Util.parseHtml("<html lang='fr-CA'><body></body></html>");
    assert.equal(parser.extractLanguage(dom), "fr");
  });

  test("extractLanguage prefers og:locale", () => {
    const dom = Util.parseHtml(
      "<html lang='en'><head><meta property='og:locale' content='de_DE'/></head><body></body></html>"
    );
    assert.equal(parser.extractLanguage(dom), "de");
  });

  test("extractLanguage defaults to en", () => {
    assert.equal(parser.extractLanguage(null), "en");
  });

  test("extractCoverImageUrl has no default", () => {
    assert.equal(parser.extractCoverImageUrl(parse()), null);
  });

  test("extractMetaInfo combines the pieces and fills fallbacks", () => {
    const info = parser.extractMetaInfo(parse());
    assert.equal(info.title, "A Story");
    assert.equal(info.author, "Unknown");
    assert.equal(info.language, "en");
    assert.equal(info.publisher, "Example");
  });
});

describe("Parser chapter labels", () => {
  const parser = new StoryParser();

  test("makeListLabel joins number and title without needing a DOM", () => {
    assert.equal(
      parser.makeListLabel({ chapterNumber: "12", title: "The Fall", sourceUrl: "u" }),
      "Chapter 12 - The Fall"
    );
  });

  test("makeListLabel uses just the title when there is no number", () => {
    assert.equal(
      parser.makeListLabel({ chapterNumber: "", title: "Prologue", sourceUrl: "u" }),
      "Prologue"
    );
  });

  test("makeListLabel falls back to the URL", () => {
    assert.equal(parser.makeListLabel({ sourceUrl: "https://x/y/" }), "https://x/y/");
  });

  test("makeChapterLabel prefers the page heading over the list title", () => {
    class Heading extends StoryParser {
      findChapterTitle() { return "From The Page"; }
    }
    assert.equal(
      new Heading().makeChapterLabel(parse(), { chapterNumber: "3", title: "From List" }),
      "Chapter 3 - From The Page"
    );
  });
});

describe("Parser.cleanContent", () => {
  test("removes scripts, styles, forms, frames and hidden nodes", () => {
    const parser = new StoryParser();
    const content = parser.cleanContent(parse().querySelector("#story"));
    assert.equal(content.querySelector("script, style, noscript, button, iframe"), null);
    assert.equal(content.querySelector("[aria-hidden='true']"), null);
  });

  test("removes comments", () => {
    const parser = new StoryParser();
    const content = parser.cleanContent(parse().querySelector("#story"));
    assert.ok(!content.innerHTML.includes("a comment"));
  });

  test("keeps the story paragraphs", () => {
    const parser = new StoryParser();
    const content = parser.cleanContent(parse().querySelector("#story"));
    const text = content.textContent;
    assert.ok(text.includes("First paragraph."));
    assert.ok(text.includes("Second"));
  });

  test("swaps a lazy placeholder for the real image src", () => {
    const parser = new StoryParser();
    const content = parser.cleanContent(parse().querySelector("#story"));
    const img = content.querySelector("img");
    assert.equal(img.getAttribute("src"), "https://cdn.test/real.png");
    assert.equal(img.getAttribute("srcset"), null);
    assert.equal(img.getAttribute("data-src"), null);
  });

  test("removes elements listed by the plugin, not the core", () => {
    const plain = new StoryParser().cleanContent(parse().querySelector("#story"));
    assert.ok(plain.querySelector(".site-clutter"), "base class keeps unknown markup");

    class WithClutter extends StoryParser {
      get contentSelectorsToRemove() { return [".site-clutter", ".ad"]; }
    }
    const cleaned = new WithClutter().cleanContent(parse().querySelector("#story"));
    assert.equal(cleaned.querySelector(".site-clutter"), null);
    assert.equal(cleaned.querySelector(".ad"), null);
  });

  test("the base class removes no site specific selectors", () => {
    assert.deepEqual(new StoryParser().contentSelectorsToRemove, []);
  });

  test("drops empty elements left behind by the removals", () => {
    const parser = new StoryParser();
    const content = parser.cleanContent(parse().querySelector("#story"));
    assert.equal(content.querySelector(".empty"), null);
  });
});

describe("Parser.buildChapterContent", () => {
  test("returns well formed XHTML and a label", async () => {
    const parser = new StoryParser();
    const { xhtml, label } = await parser.buildChapterContent(parse(), {
      sourceUrl: "https://example.com/novel/chapter-1/", chapterNumber: "3", title: "Middle",
    });
    assert.equal(label, "Chapter 3 - Middle");
    assert.ok(isWellFormedXml(xhtml), xmlParseError(xhtml));
    assert.ok(xhtml.includes("<h1>Chapter 3 - Middle</h1>"));
    assert.ok(xhtml.includes("First paragraph."));
  });

  test("does not mutate the source document", async () => {
    const parser = new StoryParser();
    const dom = parse();
    const before = dom.querySelector("#story").innerHTML;
    await parser.buildChapterContent(dom, { sourceUrl: "u", chapterNumber: "1" });
    assert.equal(dom.querySelector("#story").innerHTML, before);
  });

  test("reports a helpful error when the site layout changed", async () => {
    const parser = new StoryParser();
    const dom = Util.parseHtml("<html><body><div>no story here</div></body></html>");
    await assert.rejects(
      () => parser.buildChapterContent(dom, { sourceUrl: "https://example.com/gone" }),
      /Unable to find story content.*layout may have changed/s
    );
  });
});

describe("Parser.fetchChapter", () => {
  test("fetches the chapter page and builds it, with the toc url as referer", async () => {
    const parser = new StoryParser();
    parser.tocUrl = "https://example.com/novel/";
    const requests = [];
    globalThis.fetch = async (url, init) => {
      requests.push({ url: String(url), init });
      return {
        ok: true, status: 200,
        async text() { return DIRTY_HTML; },
      };
    };
    const { xhtml, label } = await parser.fetchChapter({
      sourceUrl: "https://example.com/novel/chapter-1/", chapterNumber: "3", title: "Middle",
    });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "https://example.com/novel/chapter-1/");
    assert.equal(requests[0].init.headers["Referer"], "https://example.com/novel/");
    assert.equal(label, "Chapter 3 - Middle");
    assert.ok(isWellFormedXml(xhtml), xmlParseError(xhtml));
  });

  test("passes the image collector through to the build step", async () => {
    const parser = new StoryParser();
    globalThis.fetch = async () => ({ ok: true, status: 200, async text() { return DIRTY_HTML; } });
    const seen = [];
    await parser.fetchChapter(
      { sourceUrl: "https://example.com/novel/chapter-1/", chapterNumber: "3" },
      { collectImagesInDocument: async (content) => { seen.push(content); } }
    );
    assert.equal(seen.length, 1);
  });

  test("is the single seam a site plugin overrides to fetch JSON", async () => {
    // the base class only knows how to fetch HTML; a site whose chapters are
    // JSON replaces this method wholesale
    assert.equal(typeof Parser.prototype.fetchChapter, "function");
    assert.equal(Parser.prototype.fetchChapter.length, 2);
  });
});

describe("Parser.getTocUrl", () => {
  test("defaults to the URL itself", () => {
    assert.equal(new StoryParser().getTocUrl("https://example.com/a"), "https://example.com/a");
  });
});

describe("Parser.extractJsonLd", () => {
  test("collects and parses every JSON-LD block, skipping broken ones", () => {
    const dom = Util.parseHtml(
      `<html><head>
        <script type="application/ld+json">{"name":"A"}</script>
        <script type="application/ld+json">{not json}</script>
        <script type="application/ld+json">{"name":"B"}</script>
      </head><body></body></html>`
    );
    const found = Parser.extractJsonLd(dom).map((d) => d.name);
    assert.deepEqual(found, ["A", "B"]);
  });
});

describe("Parser.makeSaveAsFileName", () => {
  test("uses the metadata title, sanitised", () => {
    const parser = new StoryParser();
    parser.metaInfo = { title: "A Story: Volume 1/2" };
    assert.equal(parser.makeSaveAsFileName(), "A Story_ Volume 1_2.epub");
  });

  test("falls back to novel.epub", () => {
    assert.equal(new StoryParser().makeSaveAsFileName(), "novel.epub");
  });
});
