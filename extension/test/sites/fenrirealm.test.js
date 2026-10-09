/*
  Tests for the fenrirealm.com plugin.

  Runs entirely against the saved story page, the saved chapter list API
  response and real chapter API captures from test/fixtures/fenrirealm/,
  plus a stubbed network, so it never touches fenrirealm.com or any other site.
*/

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { installDom, isWellFormedXml, xmlParseError } from "../helpers/dom.js";
import { readFixture, readFixtureDom, readFixtureJson } from "../helpers/fixtures.js";
import {
  createFetchStub, jsonResponse, htmlResponse, errorResponse, imageResponse,
  disableSleeps, PNG_BYTES,
} from "../helpers/fakeNetwork.js";

const SITE = "fenrirealm";
const STORY_URL = "https://fenrirealm.com/series/absolute-regression";
const CHAPTER_1_URL = "https://fenrirealm.com/series/absolute-regression/1";
const COVER_URL =
  "https://fenrirealm.com/storage/161/1dbd31d969adcaac358e385b95c9916a.png";

before(() => { installDom({ url: STORY_URL }); });

const { FenriRealmParser, seriesSlugFromUrl, chapterPathFor, authTokenFrom } =
  await import("../../sites/fenrirealm/FenriRealmParser.js");
const { proseMirrorToHtml } = await import("../../sites/fenrirealm/content.js");
const { parseDataResponse, unflattenDataNode } =
  await import("../../sites/fenrirealm/svelteData.js");
const { fenrirealmSite } = await import("../../sites/fenrirealm/index.js");
const { parserFactory } = await import("../../sites/index.js");
const { Parser } = await import("../../core/Parser.js");
const { Util } = await import("../../core/Util.js");
const { ImageCollector } = await import("../../core/ImageCollector.js");

let restoreSleeps;
before(() => { restoreSleeps = disableSleeps(); });
after(() => { restoreSleeps?.(); });

function makeParser(options = {}) {
  const parser = new FenriRealmParser(options);
  parser.tocUrl = STORY_URL;
  return parser;
}

/**
 * A parser on a stubbed network: the saved chapter list and real chapter API
 * captures keyed by their `/api/new/v2/series/.../{number}` path.
 */
async function parserWithApi(dataByPath = {}, options = {}) {
  const list = await readFixtureJson(SITE, "chapters-api.json");
  const fetchStub = createFetchStub([
    {
      match: (url) => /^\/api\/new\/v2\/series\/[^/]+\/chapters$/.test(url.pathname),
      respond: (url) => {
        if (url.searchParams.size > 0) {
          return jsonResponse({ message: "unexpected query string" }, 400);
        }
        return jsonResponse(list);
      },
    },
    {
      match: (url) =>
        /^\/api\/new\/v2\/series\/[^/]+\/.+/.test(url.pathname) &&
        !url.pathname.endsWith("/chapters"),
      respond: (url, info) => {
        if (info.headers.accept !== "application/json") {
          return htmlResponse("<!doctype html><html><body>error</body></html>", 500);
        }
        const body = dataByPath[url.pathname];
        if (body == null) return errorResponse(404, "no data");
        return typeof body === "string"
          ? jsonResponse(JSON.parse(body))
          : jsonResponse(body);
      },
    },
    {
      match: (url) => url.pathname.startsWith("/storage/"),
      respond: () => imageResponse(PNG_BYTES, "image/png"),
    },
    { match: () => true, respond: () => errorResponse(404) },
  ]);
  globalThis.fetch = fetchStub;
  return { parser: makeParser(options), fetchStub };
}

/** A real capture, served verbatim. */
async function dataFixture(name) {
  return await readFixture(SITE, `data-${name}.json`);
}

/** A real chapter API capture, already parsed. */
async function chapterFixture(name) {
  return await readFixtureJson(SITE, `${name}.json`);
}

const ZERO_WIDTH = /[\u200B\u200C\u200D\u2060\uFEFF]/;

// ---------------------------------------------------------------------------

describe("fenrirealm site definition", () => {
  test("is registered for its host name", () => {
    assert.ok(parserFactory.supportedHostNames().includes("fenrirealm.com"));
    const parser = parserFactory.fetchByUrl(STORY_URL);
    assert.ok(parser instanceof FenriRealmParser);
  });

  test("the definition exposes a name and host names", () => {
    assert.equal(fenrirealmSite.name, "FenrirRealm");
    assert.deepEqual(fenrirealmSite.hostNames, ["fenrirealm.com"]);
    assert.ok(fenrirealmSite.create() instanceof FenriRealmParser);
  });

  test("extends the shared base parser", () => {
    assert.ok(new FenriRealmParser() instanceof Parser);
  });
});

describe("fenrirealm.getTocUrl", () => {
  const parser = makeParser();

  test("turns a chapter URL into its story page", () => {
    assert.equal(parser.getTocUrl(CHAPTER_1_URL), STORY_URL);
  });

  test("collapses a group chapter URL to the series page", () => {
    assert.equal(
      parser.getTocUrl("https://fenrirealm.com/series/absolute-regression/bonus/12"),
      STORY_URL
    );
  });

  test("leaves a story page URL alone", () => {
    assert.equal(parser.getTocUrl(STORY_URL), STORY_URL);
  });

  test("leaves an unrelated URL alone", () => {
    assert.equal(parser.getTocUrl("https://example.com/x"), "https://example.com/x");
  });

  test("the slug is read out of the path", () => {
    assert.equal(seriesSlugFromUrl(CHAPTER_1_URL), "absolute-regression");
    assert.equal(seriesSlugFromUrl("https://example.com/x"), null);
  });
});

describe("fenrirealm chapter urls", () => {
  test("a plain chapter is /series/{slug}/{number}", () => {
    assert.equal(chapterPathFor({ number: 12 }, "s"), "/series/s/12");
  });

  test("a part is appended to the number", () => {
    assert.equal(chapterPathFor({ number: 1, part: 5 }, "s"), "/series/s/1.5");
  });

  test("a group becomes its own path segment", () => {
    assert.equal(
      chapterPathFor({ number: 12, group: { slug: "bonus" } }, "s"),
      "/series/s/bonus/12"
    );
  });

  test("a part inside a group is both used", () => {
    assert.equal(
      chapterPathFor({ number: 1, part: 2, group: { slug: "bonus" } }, "s"),
      "/series/s/bonus/1.2"
    );
  });

  test("slug is used when there is no number", () => {
    assert.equal(chapterPathFor({ slug: "prologue" }, "s"), "/series/s/prologue");
  });
});

describe("fenrirealm metadata", () => {
  let info;
  before(async () => { info = makeParser().extractMetaInfo(await readFixtureDom(SITE, "story.html")); });

  test("the title comes from the story page heading", () => {
    assert.equal(info.title, "Absolute Regression");
  });

  test("the author comes from the profile link", () => {
    assert.equal(info.author, "fenrirtl");
  });

  test("the cover is the og:image", () => {
    assert.equal(info.coverImageUrl, COVER_URL);
  });

  test("the description comes from og:description, not the generic meta tag", () => {
    assert.match(info.description, /Send me to the past/);
  });

  test("the publisher is the site", () => {
    assert.equal(info.publisher, "Fenrir Realm");
  });

  test("the language is English", () => {
    assert.equal(info.language, "en");
  });

  test("the toc url is recorded", () => {
    assert.equal(info.tocUrl, STORY_URL);
  });
});

describe("fenrirealm.getChapterList", () => {
  test("reads the saved API response in one request", async () => {
    const { parser, fetchStub } = await parserWithApi();
    const chapters = await parser.getChapterList(await readFixtureDom(SITE, "story.html"));

    assert.equal(chapters.length, 9, "every chapter should be listed");
    assert.equal(fetchStub.requests.length, 1, "the chapter list needs no pagination");
    assert.equal(
      fetchStub.requests[0].url.pathname,
      "/api/new/v2/series/absolute-regression/chapters"
    );
    assert.equal(fetchStub.requests[0].headers.accept, "application/json");
  });

  test("lists the premium chapters instead of hiding them", async () => {
    const { parser } = await parserWithApi();
    const chapters = await parser.getChapterList(await readFixtureDom(SITE, "story.html"));
    assert.deepEqual(
      chapters.map((c) => c.chapterNumber),
      ["1", "2", "3", "894", "895", "896", "1.5", "12", "857"]
    );
  });

  test("marks a seal bought chapter as premium and unlocked", async () => {
    // the bug this pins down: buying a chapter with a seal records the purchase
    // under `bought` but never stamps `locked.unlocked_at`, so a list that only
    // believes unlocked_at silently drops every chapter the reader paid for
    const { parser } = await parserWithApi();
    const chapters = await parser.getChapterList(await readFixtureDom(SITE, "story.html"));
    const bought = chapters.find((c) => c.chapterNumber === "894");
    assert.equal(bought.isPremium, true);
    assert.equal(bought.isUnlocked, true);
    assert.equal(bought.sourceUrl, "https://fenrirealm.com/series/absolute-regression/894");
  });

  test("marks a premium chapter the account has not bought", async () => {
    const { parser } = await parserWithApi();
    const chapters = await parser.getChapterList(await readFixtureDom(SITE, "story.html"));
    const notBought = chapters.find((c) => c.chapterNumber === "857");
    assert.equal(notBought.isPremium, true);
    assert.equal(notBought.isUnlocked, false);
  });

  test("leaves the free chapters unmarked", async () => {
    const { parser } = await parserWithApi();
    const chapters = await parser.getChapterList(await readFixtureDom(SITE, "story.html"));
    for (const chapter of chapters.filter((c) => c.chapterNumber !== "857" && !c.isPremium)) {
      assert.equal(chapter.isUnlocked, true);
    }
    const first = chapters[0];
    assert.equal(first.isPremium, false);
    assert.equal(first.isUnlocked, true);
  });

  test("builds the chapter url the site itself uses", async () => {
    const { parser } = await parserWithApi();
    const chapters = await parser.getChapterList(await readFixtureDom(SITE, "story.html"));
    assert.equal(chapters[0].sourceUrl, CHAPTER_1_URL);
    assert.equal(chapters[0].title, "Send Me to the Past");
    assert.equal(chapters[0].language, "en");
  });

  test("keeps part and group chapters addressable", async () => {
    const { parser } = await parserWithApi();
    const chapters = await parser.getChapterList(await readFixtureDom(SITE, "story.html"));
    assert.equal(chapters[6].sourceUrl, "https://fenrirealm.com/series/absolute-regression/1.5");
    assert.equal(chapters[7].sourceUrl, "https://fenrirealm.com/series/absolute-regression/bonus/12");
  });

  test("labels read as 'Chapter {n} - {title}'", async () => {
    const { parser } = await parserWithApi();
    const chapters = await parser.getChapterList(await readFixtureDom(SITE, "story.html"));
    assert.equal(parser.makeListLabel(chapters[0]), "Chapter 1 - Send Me to the Past");
  });

  test("fails clearly when the response is not a list", async () => {
    globalThis.fetch = createFetchStub([
      { match: () => true, respond: () => jsonResponse({ data: [] }) },
    ]);
    const parser = makeParser();
    const dom = await readFixtureDom(SITE, "story.html");
    await assert.rejects(
      () => parser.getChapterList(dom),
      /unexpected chapter list response/
    );
  });

  test("fails clearly when there is no series slug", async () => {
    const parser = makeParser();
    parser.tocUrl = "https://fenrirealm.com/";
    const dom = await readFixtureDom(SITE, "story.html");
    await assert.rejects(
      () => parser.getChapterList(dom),
      /series slug/
    );
  });
});

describe("fenrirealm chapter content, from real captures", () => {
  const CH1_API = "/api/new/v2/series/absolute-regression/1";
  const CH855_API = "/api/new/v2/series/absolute-regression/855";

  async function fetchReal(fixture, apiPath, chapterNumber) {
    const body = await chapterFixture(fixture);
    const { parser, fetchStub } = await parserWithApi({ [apiPath]: body });
    const result = await parser.fetchChapter({
      sourceUrl: `https://fenrirealm.com/series/absolute-regression/${chapterNumber}`,
      chapterNumber,
      title: "ignored, the label comes from the site",
    });
    return { ...result, fetchStub };
  }

  test("a real html body becomes well formed XHTML", async () => {
    const { xhtml, label } = await fetchReal("api-chapter-1", CH1_API, "1");
    assert.ok(isWellFormedXml(xhtml), xmlParseError(xhtml));
    assert.equal(label, "Chapter 1 - Send Me to the Past");
    assert.match(xhtml, /<h1>Chapter 1 - Send Me to the Past<\/h1>/);
    assert.match(xhtml, /Spirit Master Seo Gong silently stared/);
  });

  test("a non breaking space becomes a numeric reference, not &nbsp;", async () => {
    const { xhtml } = await fetchReal("api-chapter-1", CH1_API, "1");
    // &nbsp; is defined in HTML but not in XML, so it would stop the chapter
    // parsing as XHTML at all
    assert.ok(!/&nbsp;/.test(xhtml), "an undefined XML entity reached the XHTML");
    assert.ok(!/\u00a0/.test(xhtml), "a literal U+00A0 reached the XHTML");
    assert.ok(isWellFormedXml(xhtml), xmlParseError(xhtml));
  });

  test("an html body from another chapter becomes well formed XHTML", async () => {
    const { xhtml, label } = await fetchReal("api-chapter-855", CH855_API, "855");
    assert.ok(isWellFormedXml(xhtml), xmlParseError(xhtml));
    assert.equal(label, "Chapter 855 - Have You Decided Who to Choose?");
    assert.match(xhtml, /I made a bet with Father on who would win\./);
  });

  test("the zero width characters are stripped from the text", async () => {
    for (const [fixture, path, number] of [
      ["api-chapter-1", CH1_API, "1"],
      ["api-chapter-855", CH855_API, "855"],
    ]) {
      const { xhtml } = await fetchReal(fixture, path, number);
      assert.ok(!ZERO_WIDTH.test(xhtml), `${fixture} kept a zero width character`);
    }
  });

  test("asks the chapter API the site's reader uses", async () => {
    const { fetchStub } = await fetchReal("api-chapter-855", CH855_API, "855");
    const last = fetchStub.requests.at(-1);
    assert.equal(
      last.url.href,
      "https://fenrirealm.com/api/new/v2/series/absolute-regression/855"
    );
    assert.equal(last.headers.accept, "application/json");
    assert.equal(last.headers["x-accepts-encrypted-content"], "2");
  });

  test("surfaces an http failure", async () => {
    const { parser } = await parserWithApi({});
    await assert.rejects(
      () => parser.fetchChapter({
        sourceUrl: "https://fenrirealm.com/series/absolute-regression/7",
        chapterNumber: "7", title: "",
      }),
      /HTTP 404/
    );
  });
});

describe("fenrirealm premium chapters and the account token", () => {
  const PREMIUM_API = "/api/new/v2/series/absolute-regression/865";
  const CHAPTER_URL = "https://fenrirealm.com/series/absolute-regression/865";

  /** A page whose inline bootstrap data carries the given token literal. */
  function pageHtmlWithToken(tokenLiteral) {
    return (
      "<!doctype html><html><body>" +
      "<h1 id='series-title'>Absolute Regression</h1>" +
      "<script>" +
      "__sveltekit_x = {base:''};" +
      "kit.start(app, element, {data:[{type:'data',data:{" +
      `token:${tokenLiteral},isImpersonating:false},uses:{}}]});` +
      "</script></body></html>"
    );
  }

  test("reads a real JWT off the page, but not a 'session' flag", () => {
    const dom = Util.parseHtml(pageHtmlWithToken('"eyJhbGciOi.payload.sig"'));
    assert.equal(authTokenFrom(dom), "eyJhbGciOi.payload.sig");
    const session = Util.parseHtml(pageHtmlWithToken('"session"'));
    assert.equal(authTokenFrom(session), null);
  });

  test("a signed out page (token:void 0) yields no token", () => {
    const dom = Util.parseHtml(pageHtmlWithToken("void 0"));
    assert.equal(authTokenFrom(dom), null);
  });

  test("the chapter request carries the token as a bearer header", async () => {
    const chapter = await chapterFixture("api-chapter-1");
    const { parser, fetchStub } = await parserWithApi({ [PREMIUM_API]: chapter });
    parser.authToken = "eyJhbGciOi.payload.sig";
    await parser.fetchChapter({
      sourceUrl: CHAPTER_URL, chapterNumber: "865", title: "", isPremium: true,
    });
    const last = fetchStub.requests.at(-1);
    assert.equal(last.headers.authorization, "Bearer eyJhbGciOi.payload.sig");
  });

  test("no authorization header is sent when signed out", async () => {
    const chapter = await chapterFixture("api-chapter-1");
    const { parser, fetchStub } = await parserWithApi({ [PREMIUM_API]: chapter });
    await parser.fetchChapter({
      sourceUrl: CHAPTER_URL, chapterNumber: "865", title: "", isPremium: true,
    });
    const last = fetchStub.requests.at(-1);
    assert.equal(last.headers.authorization, undefined);
  });

  test("a teaser the server still returns is reported as locked", async () => {
    const preview = await chapterFixture("api-chapter-865-preview");
    const { parser } = await parserWithApi({ [PREMIUM_API]: preview });
    await assert.rejects(
      () => parser.fetchChapter({
        sourceUrl: CHAPTER_URL, chapterNumber: "865", title: "", isPremium: true,
      }),
      /locked/
    );
  });

  test("a purchased premium chapter is retried with the token off its page", async () => {
    const preview = await chapterFixture("api-chapter-865-preview");
    const full = await chapterFixture("api-chapter-1");
    const jwt = "eyJhbGciOi.payload.sig";
    const page = new URL(CHAPTER_URL).pathname;
    const fetchStub = createFetchStub([
      {
        match: (url, info) =>
          url.pathname === PREMIUM_API && info.headers.authorization === `Bearer ${jwt}`,
        respond: () => jsonResponse(full),
      },
      {
        match: (url) => url.pathname === PREMIUM_API,
        respond: () => jsonResponse(preview),
      },
      {
        match: (url) => url.pathname === page,
        respond: () => htmlResponse(pageHtmlWithToken(`"${jwt}"`)),
      },
      { match: () => true, respond: () => errorResponse(404) },
    ]);
    globalThis.fetch = fetchStub;
    const parser = makeParser();

    const result = await parser.fetchChapter({
      sourceUrl: CHAPTER_URL, chapterNumber: "865", title: "", isPremium: true,
    });
    assert.match(result.xhtml, /Spirit Master Seo Gong/);
    // the retry that actually delivered the body carried the token ...
    const tokenCall = fetchStub.requests.find(
      (r) => r.url.pathname === PREMIUM_API && r.headers.authorization
    );
    assert.equal(tokenCall.headers.authorization, `Bearer ${jwt}`);
    // ... and it was read off the chapter page, not the story page
    const pageCall = fetchStub.requests.find((r) => r.url.pathname === page);
    assert.equal(pageCall.headers.accept, "text/html");
  });
});

describe("fenrirealm bodies it cannot use", () => {
  const parser = makeParser();
  const chapter = {
    sourceUrl: "https://fenrirealm.com/series/absolute-regression/5",
    chapterNumber: "5", title: "",
  };

  test("reports a locked chapter", () => {
    assert.throws(
      () => parser.buildChapterDom({ content_format: "locked", excerpt: "…" }, chapter),
      /locked for this account/
    );
  });

  test("reports the site's teaser for a chapter it will not send", () => {
    assert.throws(
      () => parser.buildChapterDom(
        { content_format: "text", content: "A short taste.", excerpt: "A short taste." },
        chapter
      ),
      /locked for this account/
    );
  });

  test("reports a body the site has not published yet", () => {
    assert.throws(
      () => parser.buildChapterDom({ content_format: "json", content: "..." }, chapter),
      /not published it yet/
    );
  });

  test("reports an empty body", () => {
    assert.throws(
      () => parser.buildChapterDom({ content_format: "html", content: "   " }, chapter),
      /no readable content/
    );
  });

  test("reports an unsupported content format", () => {
    assert.throws(
      () => parser.buildChapterDom({ content_format: "mystery", content: "x" }, chapter),
      /unsupported content format "mystery"/
    );
  });

  test("reports a json body that will not parse", () => {
    assert.throws(
      () => parser.buildChapterDom({ content_format: "json", content: "{oops" }, chapter),
      /could not be parsed/
    );
  });

  test("reports a json body with no document at all", () => {
    assert.throws(
      () => parser.buildChapterDom({ content_format: "json", content: null }, chapter),
      /sent no document/
    );
  });

  test("accepts a json body that is already an object", () => {
    const dom = parser.buildChapterDom({
      content_format: "json",
      content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }] },
    }, chapter);
    assert.match(dom.querySelector(".fenr-content").innerHTML, /hi/);
  });
});

describe("fenrirealm svelteData", () => {
  test("resolves the references in a real capture", async () => {
    const text = await dataFixture("chapter-855");
    const page = parseDataResponse(text, "https://example.com/__data.json");
    assert.equal(page.seriesSlug, "absolute-regression");
    assert.equal(page.chapterData.title, "Have You Decided Who to Choose?");
  });

  test("hoists real numbers, so a chapter number is still a number", async () => {
    const text = await dataFixture("chapter-855");
    const { chapterData } = parseDataResponse(text, "https://example.com/__data.json");
    assert.equal(chapterData.number, 855);
    assert.equal(chapterData.content_format, "html");
  });

  test("a ProseMirror body stays a string until the parser decodes it", async () => {
    const text = await dataFixture("chapter-1");
    const { chapterData } = parseDataResponse(text, "https://example.com/__data.json");
    assert.equal(typeof chapterData.content, "string");
    assert.equal(JSON.parse(chapterData.content).type, "systemWindow");
  });

  test("a paid chapter comes back as a redirect", async () => {
    const text = await dataFixture("paid-896-redirect");
    assert.throws(
      () => parseDataResponse(text, "https://example.com/__data.json"),
      (err) => {
        assert.equal(err.kind, "redirect");
        assert.match(err.message, /account/);
        return true;
      }
    );
  });

  test("an unknown series comes back as an error node", async () => {
    const text = await dataFixture("unknown-series");
    assert.throws(
      () => parseDataResponse(text, "https://example.com/__data.json"),
      (err) => {
        assert.equal(err.kind, "error");
        assert.match(err.message, /Series not found/);
        return true;
      }
    );
  });

  test("a chapter request is made with the reader's cookies", async () => {
    const { parser, fetchStub } = await parserWithApi({
      "/api/new/v2/series/absolute-regression/894": await chapterFixture("api-chapter-1"),
    });
    await parser.fetchChapter({
      sourceUrl: "https://fenrirealm.com/series/absolute-regression/894",
      chapterNumber: "894", title: "",
    });
    const last = fetchStub.requests.at(-1);
    // the whole point of buying the chapter in the browser is that these cookies
    // are already there, so the request has to carry them
    assert.equal(last.credentials, "include");
  });

  test("malformed input is rejected rather than throwing something odd", () => {
    assert.throws(() => unflattenDataNode({ type: "data" }), /Malformed/);
    assert.throws(() => parseDataResponse("[]", "u"), /unexpected response/);
  });
});

describe("fenrirealm proseMirrorToHtml", () => {
  test("an unknown node type keeps its text", () => {
    const html = proseMirrorToHtml({
      type: "doc",
      content: [{ type: "brandNewWrapper", content: [{ type: "text", text: "kept" }] }],
    });
    assert.equal(html, "kept");
  });

  test("an empty paragraph produces nothing", () => {
    assert.equal(
      proseMirrorToHtml({ type: "doc", content: [{ type: "paragraph", content: [] }] }),
      ""
    );
  });

  test("a horizontal rule survives", () => {
    assert.equal(
      proseMirrorToHtml({ type: "doc", content: [{ type: "horizontalRule" }] }),
      "<hr/>"
    );
  });

  test("a missing content array is empty", () => {
    assert.equal(proseMirrorToHtml({ type: "doc" }), "");
    assert.equal(proseMirrorToHtml(null), "");
  });

  test("an image without a src is dropped", () => {
    assert.equal(
      proseMirrorToHtml({ type: "doc", content: [{ type: "image", attrs: { alt: "x" } }] }),
      ""
    );
  });
});

describe("fenrirealm does not affect other sites", () => {
  test("its clutter selectors are its own", () => {
    const selectors = new FenriRealmParser().contentSelectorsToRemove;
    assert.ok(selectors.includes("#unlock-chapter"));
    assert.ok(!selectors.includes(".reader-text"), "borrowed another site's selector");
  });

  test("throttles politely", () => {
    assert.ok(new FenriRealmParser().minimumThrottle >= 500);
  });
});
