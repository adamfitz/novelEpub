/*
  Tests for the roliascan.com plugin.

  Runs entirely against the real pages saved in
  test/fixtures/roliascan/ plus a stubbed network, so it never touches
  fenrirealm.com or any other site.
*/

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { installDom, isWellFormedXml, xmlParseError } from "../helpers/dom.js";
import { readFixtureDom, readFixtureJson } from "../helpers/fixtures.js";
import {
  createFetchStub, jsonResponse, errorResponse, disableSleeps,
} from "../helpers/fakeNetwork.js";

const SITE = "roliascan";
const STORY_URL = "https://roliascan.com/manga/evolution-from-little-devil-to-devil-empress-novel/";
const CHAPTER_1_URL =
  "https://roliascan.com/read/evolution-from-little-devil-to-devil-empress-novel/ch1-173457/";
const CHAPTER_4_URL =
  "https://roliascan.com/read/evolution-from-little-devil-to-devil-empress-novel/ch4-173460/";

before(() => { installDom({ url: STORY_URL }); });

const { RoliaScansParser } = await import("../../sites/roliascan/RoliaScansParser.js");
const { roliascanSite } = await import("../../sites/roliascan/index.js");
const { parserFactory } = await import("../../sites/index.js");
const { Parser } = await import("../../core/Parser.js");
const { Util } = await import("../../core/Util.js");

let restoreSleeps;
before(() => { restoreSleeps = disableSleeps(); });
after(() => { restoreSleeps?.(); });

/** A parser whose network is stubbed with the saved API fixtures. */
async function parserWithApi(options = {}) {
  const page0 = await readFixtureJson(SITE, "chapters-api-offset-0.json");
  const page8 = await readFixtureJson(SITE, "chapters-api-offset-8.json");
  const fetchStub = createFetchStub([
    {
      match: (url) => url.pathname === "/auth/manga-chapters",
      respond: (url) => {
        const offset = Number(url.searchParams.get("offset"));
        if (url.searchParams.get("manga_id") !== "171369") {
          return jsonResponse({ success: false, message: "bad id" }, 400);
        }
        if (!url.searchParams.get("_t") || !url.searchParams.get("_ts")) {
          return jsonResponse({ success: false, message: "missing token" }, 400);
        }
        return jsonResponse(offset === 0 ? page0 : page8);
      },
    },
    { match: () => true, respond: () => errorResponse(404) },
  ]);
  globalThis.fetch = fetchStub;
  const parser = new RoliaScansParser(options);
  parser.tocUrl = STORY_URL;
  return { parser, fetchStub };
}

function makeParser(options = {}) {
  const parser = new RoliaScansParser(options);
  parser.tocUrl = STORY_URL;
  return parser;
}

describe("roliascan site definition", () => {
  test("is registered for its host name", () => {
    assert.ok(parserFactory.supportedHostNames().includes("roliascan.com"));
    const parser = parserFactory.fetchByUrl(`${STORY_URL}`);
    assert.ok(parser instanceof RoliaScansParser);
  });

  test("the factory builds a new instance per lookup", () => {
    const a = parserFactory.fetchByUrl(STORY_URL);
    const b = parserFactory.fetchByUrl(STORY_URL);
    assert.notEqual(a, b);
  });

  test("the definition exposes a name and host names", () => {
    assert.equal(roliascanSite.name, "RoliaScans");
    assert.deepEqual(roliascanSite.hostNames, ["roliascan.com"]);
    assert.ok(roliascanSite.create() instanceof RoliaScansParser);
  });

  test("extends the shared base parser", () => {
    assert.ok(new RoliaScansParser() instanceof Parser);
  });
});

describe("roliascan.getTocUrl", () => {
  const parser = makeParser();

  test("turns a chapter URL into its story page", () => {
    assert.equal(parser.getTocUrl(CHAPTER_4_URL), STORY_URL);
  });

  test("leaves a story page URL alone", () => {
    assert.equal(parser.getTocUrl(STORY_URL), STORY_URL);
  });

  test("leaves an unrelated URL alone", () => {
    assert.equal(parser.getTocUrl("https://example.com/x"), "https://example.com/x");
  });
});

describe("roliascan metadata from the real story page", () => {
  let dom;
  let info;

  before(async () => {
    dom = await readFixtureDom(SITE, "story.html");
    const parser = makeParser();
    info = parser.extractMetaInfo(dom);
  });

  test("title comes from the page heading", () => {
    assert.equal(info.title, "Evolution: From Little Devil to Devil Empress");
  });

  test("author is found", () => {
    assert.equal(info.author, "Addicted_To_Coffee");
  });

  test("cover image is an absolute url on the site", () => {
    assert.ok(Util.isUrl(info.coverImageUrl));
    assert.ok(info.coverImageUrl.startsWith("https://roliascan.com/content/media/"));
  });

  test("description is extracted", () => {
    assert.ok(info.description.length > 50, `description too short: ${info.description}`);
  });

  test("language and publisher", () => {
    assert.equal(info.language, "en");
    assert.equal(info.publisher, "roliascan.com");
  });

  test("the save-as file name is derived from the title", () => {
    const parser = makeParser();
    parser.metaInfo = info;
    assert.equal(
      parser.makeSaveAsFileName(),
      "Evolution_ From Little Devil to Devil Empress.epub"
    );
  });
});

describe("roliascan chapter list", () => {
  test("reads the manga id off the story page", async () => {
    const dom = await readFixtureDom(SITE, "story.html");
    const { parser, fetchStub } = await parserWithApi();
    const chapters = await parser.getChapterList(dom);
    const apiRequest = fetchStub.requests.find((r) => r.url.pathname === "/auth/manga-chapters");
    assert.equal(apiRequest.url.searchParams.get("manga_id"), "171369");
    assert.ok(chapters.length > 0);
  });

  test("pages through the API until has_more is false", async () => {
    const dom = await readFixtureDom(SITE, "story.html");
    const { parser, fetchStub } = await parserWithApi();
    await parser.getChapterList(dom);
    const offsets = fetchStub.requests
      .filter((r) => r.url.pathname === "/auth/manga-chapters")
      .map((r) => r.url.searchParams.get("offset"));
    assert.deepEqual(offsets, ["0", "8"]);
  });

  test("sends the anti-scrape token and timestamp on every API call", async () => {
    const dom = await readFixtureDom(SITE, "story.html");
    const { parser, fetchStub } = await parserWithApi();
    await parser.getChapterList(dom);
    for (const request of fetchStub.requests) {
      if (request.url.pathname !== "/auth/manga-chapters") continue;
      const token = request.url.searchParams.get("_t");
      const timestamp = request.url.searchParams.get("_ts");
      assert.match(token, /^[0-9a-f]{16}$/, "token is a 16 char md5 prefix");
      assert.match(timestamp, /^\d{10}$/, "timestamp is unix seconds");
    }
  });

  test("asks for chapters in ascending order with a limit", async () => {
    const dom = await readFixtureDom(SITE, "story.html");
    const { parser, fetchStub } = await parserWithApi();
    await parser.getChapterList(dom);
    const first = fetchStub.requests.find((r) => r.url.pathname === "/auth/manga-chapters");
    assert.equal(first.url.searchParams.get("order"), "ASC");
    assert.equal(first.url.searchParams.get("limit"), "500");
  });

  test("returns chapters with a url, number and title", async () => {
    const dom = await readFixtureDom(SITE, "story.html");
    const { parser } = await parserWithApi();
    const chapters = await parser.getChapterList(dom);
    const first = chapters[0];
    assert.equal(first.chapterNumber, "1");
    assert.equal(first.title, "Liora Veythalis...");
    assert.ok(Util.isUrl(first.sourceUrl));
    assert.ok(first.sourceUrl.includes("/read/"));
  });

  test("drops duplicate chapter numbers, keeping one entry each", async () => {
    const dom = await readFixtureDom(SITE, "story.html");
    const { parser } = await parserWithApi();
    const chapters = await parser.getChapterList(dom);
    const numbers = chapters.map((c) => String(c.chapterNumber));
    assert.equal(new Set(numbers).size, numbers.length, `duplicates in ${numbers.join(",")}`);
    // the saved fixture deliberately repeats chapter 10
    assert.equal(numbers.filter((n) => n === "10").length, 1);
  });

  test("keeps the site order across pages", async () => {
    const dom = await readFixtureDom(SITE, "story.html");
    const { parser } = await parserWithApi();
    const chapters = await parser.getChapterList(dom);
    const numbers = chapters.map((c) => Number(c.chapterNumber));
    const sorted = [...numbers].sort((a, b) => a - b);
    assert.deepEqual(numbers, sorted);
  });

  test("explains itself when the story page has no manga id", async () => {
    const dom = Util.parseHtml("<html><body><h1>No id here</h1></body></html>");
    const { parser } = await parserWithApi();
    await assert.rejects(() => parser.getChapterList(dom), /manga id/);
  });

  test("explains itself when the API rejects the request", async () => {
    const dom = await readFixtureDom(SITE, "story.html");
    globalThis.fetch = createFetchStub([
      {
        match: (url) => url.pathname === "/auth/manga-chapters",
        respond: () => jsonResponse({ success: false }, 200),
      },
    ]);
    const parser = makeParser();
    await assert.rejects(() => parser.getChapterList(dom), /rejected the chapter list/);
  });
});

describe("roliascan chapter content from the real chapter page", () => {
  test("finds the story text container", async () => {
    const dom = await readFixtureDom(SITE, "chapter-1.html");
    const content = makeParser().findContent(dom);
    assert.ok(content != null, "no content element found");
    assert.ok(content.classList.contains("reader-text"));
  });

  test("keeps the story paragraphs", async () => {
    const dom = await readFixtureDom(SITE, "chapter-1.html");
    const { xhtml } = await makeParser().buildChapterContent(dom, {
      sourceUrl: CHAPTER_1_URL, chapterNumber: "1", title: "Liora Veythalis...",
    });
    assert.ok(
      xhtml.includes("A black, viscous river stretched as far as the eye could see"),
      "first paragraph missing"
    );
  });

  test("produces well formed XHTML", async () => {
    const dom = await readFixtureDom(SITE, "chapter-1.html");
    const { xhtml } = await makeParser().buildChapterContent(dom, {
      sourceUrl: CHAPTER_1_URL, chapterNumber: "1", title: "Liora Veythalis...",
    });
    assert.ok(isWellFormedXml(xhtml), xmlParseError(xhtml));
  });

  test("contains no script or style elements", async () => {
    const dom = await readFixtureDom(SITE, "chapter-1.html");
    const { xhtml } = await makeParser().buildChapterContent(dom, {
      sourceUrl: CHAPTER_1_URL, chapterNumber: "1", title: "Liora Veythalis...",
    });
    assert.ok(!/<script|<style/i.test(xhtml));
  });

  test("builds a label from the chapter number and page heading", async () => {
    const dom = await readFixtureDom(SITE, "chapter-1.html");
    const { label } = await makeParser().buildChapterContent(dom, {
      sourceUrl: CHAPTER_1_URL, chapterNumber: "1", title: "Liora Veythalis...",
    });
    assert.equal(label, "Chapter 1 - Liora Veythalis...");
  });

  test("works the same way for a later chapter", async () => {
    const dom = await readFixtureDom(SITE, "chapter-4.html");
    const { xhtml, label } = await makeParser().buildChapterContent(dom, {
      sourceUrl: CHAPTER_4_URL, chapterNumber: "4", title: "Young Devil [1] - Unknown Bloodline",
    });
    assert.ok(label.startsWith("Chapter 4 - "), `unexpected label ${label}`);
    assert.ok(isWellFormedXml(xhtml), xmlParseError(xhtml));
  });

  test("reports a clear error when the layout changed", async () => {
    const dom = Util.parseHtml("<html><body><div>nothing here</div></body></html>");
    await assert.rejects(
      () => makeParser().buildChapterContent(dom, { sourceUrl: "https://roliascan.com/read/x/" }),
      /layout may have changed/
    );
  });
});

describe("roliascan.findChapterTitle", () => {
  const parser = makeParser();

  test("takes the subtitle after 'Chapter n - '", async () => {
    const dom = await readFixtureDom(SITE, "chapter-1.html");
    assert.equal(parser.findChapterTitle(dom, {}), "Liora Veythalis...");
  });

  test("returns null when the heading has no subtitle", () => {
    const dom = Util.parseHtml("<html><body><h1>A Story Chapter 12</h1></body></html>");
    assert.equal(parser.findChapterTitle(dom, {}), null);
  });

  test("returns null when there is no heading", () => {
    const dom = Util.parseHtml("<html><body><p>text</p></body></html>");
    assert.equal(parser.findChapterTitle(dom, {}), null);
  });
});

describe("roliascan ad handling", () => {
  test("declares the site's own clutter selectors", () => {
    const selectors = makeParser().contentSelectorsToRemove;
    assert.ok(selectors.includes(".novel-epub-exclude"));
    assert.ok(selectors.includes(".adsbygoogle"));
    assert.ok(selectors.includes(".rolia-ad-slot"));
  });

  test("removes an ad slot that sits inside the story container", () => {
    const dom = Util.parseHtml(
      "<html><body><div class='reader-text'>" +
      "<p>Story text.</p>" +
      "<div class='rolia-ad-slot'>advert</div>" +
      "</div></body></html>"
    );
    const content = makeParser().cleanContent(dom.querySelector(".reader-text"));
    assert.equal(content.querySelector(".rolia-ad-slot"), null);
    assert.ok(content.textContent.includes("Story text."));
  });
});
