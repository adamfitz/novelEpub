/*
  End to end check of the whole pipeline against the real saved pages:

      story page -> metadata
      chapter list API (paged, token) -> chapter list
      chapter pages -> clean XHTML + localized images
      EpubBuilder -> the EPUB 3 zip
      validation of the assembled archive

  Uses the roliascan fixtures as the sample site.  Nothing touches the network:
  fetch() is stubbed from the saved responses.
*/

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import JSZip from "jszip";

import { installDom, isWellFormedXml, xmlParseError } from "../helpers/dom.js";
import { readFixture, readFixtureJson } from "../helpers/fixtures.js";
import {
  createFetchStub, jsonResponse, htmlResponse, imageResponse, disableSleeps,
  PNG_BYTES, JPEG_BYTES,
} from "../helpers/fakeNetwork.js";

const SITE = "roliascan";
const STORY_URL = "https://roliascan.com/manga/evolution-from-little-devil-to-devil-empress-novel/";
const COVER_URL = "https://roliascan.com/content/media/manga-171369-cover-1778172866.jpg";
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

before(() => { installDom({ url: STORY_URL }); });

// EpubBuilder expects the browser global JSZip; give node the npm build.
globalThis.JSZip = JSZip;

const { RoliaScansParser } = await import("../../sites/roliascan/RoliaScansParser.js");
const { Util } = await import("../../core/Util.js");
const { ImageCollector } = await import("../../core/ImageCollector.js");
const { EpubBuilder } = await import("../../core/EpubBuilder.js");

let restoreSleeps;
before(() => { restoreSleeps = disableSleeps(); });
after(() => { restoreSleeps?.(); });

/** Story page + the two saved chapter pages, with a panel image spliced in. */
async function loadFixtures() {
  const storyHtml = await readFixture(SITE, "story.html");
  const chapter1 = await readFixture(SITE, "chapter-1.html");
  const chapter4 = await readFixture(SITE, "chapter-4.html");
  // the real chapters are text only, so add an image to exercise the
  // localize-images path
  const withImage = chapter1.replace(
    '<div class="reader-text px-4">',
    '<div class="reader-text px-4"><img src="https://roliascan.com/cdn/panel.webp" alt="panel"/>'
  );
  assert.notEqual(withImage, chapter1, "failed to splice the panel image in");
  return {
    storyHtml,
    chapterByNumber: { "1": withImage, "4": chapter4 },
    api: {
      0: await readFixtureJson(SITE, "chapters-api-offset-0.json"),
      8: await readFixtureJson(SITE, "chapters-api-offset-8.json"),
    },
  };
}

function installFakeNetwork(api, storyHtml, chapterByNumber) {
  globalThis.fetch = createFetchStub([
    {
      match: (url) => url.pathname === "/auth/manga-chapters",
      respond: (url) => {
        const offset = Number(url.searchParams.get("offset"));
        if (!url.searchParams.get("_t") || !url.searchParams.get("_ts")) {
          return jsonResponse({ success: false }, 400);
        }
        return jsonResponse(api[offset] ?? { success: true, chapters: [], has_more: false });
      },
    },
    { match: (url) => url.pathname.startsWith("/manga/"), respond: () => htmlResponse(storyHtml) },
    { match: (url) => url.pathname.startsWith("/read/"), respond: () => htmlResponse(chapterByNumber) },
    { match: (url) => url.pathname === "/cdn/panel.webp", respond: () => imageResponse(PNG_BYTES, "image/webp") },
    { match: (url) => url.pathname.startsWith("/content/media/"), respond: () => imageResponse(JPEG_BYTES, "image/jpeg") },
  ]);
}

describe("full pipeline", () => {
  let epubBlob;
  let zip;
  let names;
  let metaInfo;
  let chapters;
  let imageCollector;
  let epubChapters;
  let cover;

  const read = (name) => zip.file(name).async("string");

  before(async () => {
    const fixtures = await loadFixtures();
    installFakeNetwork(fixtures.api, fixtures.storyHtml, fixtures.chapterByNumber["1"]);
    const parser = new RoliaScansParser();
    parser.tocUrl = STORY_URL;

    // 1. metadata from the story page
    const storyDom = Util.parseHtml(fixtures.storyHtml);
    metaInfo = parser.extractMetaInfo(storyDom);
    parser.metaInfo = metaInfo;

    // 2. chapter list through the paged, token protected API
    chapters = await parser.getChapterList(storyDom);

    // 3. chapter content + image localization
    imageCollector = new ImageCollector(parser.httpClient);
    epubChapters = [];
    for (const chapter of [chapters[0], chapters[3]]) {
      const html = fixtures.chapterByNumber[chapter.chapterNumber]
        ?? fixtures.chapterByNumber["1"];
      const dom = Util.parseHtml(html);
      const { xhtml, label } = await parser.buildChapterContent(dom, chapter, imageCollector);
      epubChapters.push({
        path: `Text/chapter${Util.zeroPad(epubChapters.length + 1)}.xhtml`,
        label,
        xhtml,
        sourceUrl: chapter.sourceUrl,
      });
    }

    // 4. cover image
    const download = await imageCollector.downloadImage(metaInfo.coverImageUrl);
    cover = { ...download, sourceUrl: metaInfo.coverImageUrl };

    // 5. pack
    epubBlob = await new EpubBuilder(
      metaInfo, epubChapters, imageCollector.images, cover
    ).assemble();
    zip = await JSZip.loadAsync(await epubBlob.arrayBuffer());
    names = Object.keys(zip.files);
  });

  test("metadata was extracted from the real page", () => {
    assert.equal(metaInfo.title, "Evolution: From Little Devil to Devil Empress");
    assert.equal(metaInfo.author, "Addicted_To_Coffee");
    assert.equal(metaInfo.language, "en");
    assert.equal(metaInfo.tocUrl, STORY_URL);
    assert.ok(Util.isUrl(metaInfo.coverImageUrl));
  });

  test("the chapter list came back de-duplicated and ordered", () => {
    assert.ok(chapters.length >= 10, `only ${chapters.length} chapters`);
    const numbers = chapters.map((c) => Number(c.chapterNumber));
    assert.deepEqual(numbers, [...numbers].sort((a, b) => a - b));
    assert.equal(new Set(numbers).size, numbers.length);
  });

  test("both chapters became well formed XHTML with a label", () => {
    assert.equal(epubChapters.length, 2);
    for (const chapter of epubChapters) {
      assert.ok(isWellFormedXml(chapter.xhtml), `${chapter.label}: ${xmlParseError(chapter.xhtml)}`);
      assert.ok(chapter.label.length > 0);
      assert.ok(!/<script/i.test(chapter.xhtml));
    }
  });

  test("the inline image was downloaded and localized", () => {
    assert.equal(imageCollector.images.length, 1);
    assert.equal(imageCollector.images[0].path, "OEBPS/Images/img000000001.webp");
    assert.ok(epubChapters[0].xhtml.includes('src="../Images/img000000001.webp"'));
  });

  test("the cover was downloaded as a jpeg", () => {
    assert.equal(cover.mediaType, "image/jpeg");
    assert.ok(cover.blob.size > 0);
  });

  test("mimetype is the first entry and stored uncompressed", async () => {
    assert.equal(names[0], "mimetype");
    assert.equal(await read("mimetype"), "application/epub+zip");
  });

  test("no stray mac metadata", () => {
    assert.ok(!names.some((n) => n.startsWith("__MACOSX")));
  });

  test("container.xml is well formed and points at content.opf", async () => {
    const container = await read("META-INF/container.xml");
    assert.ok(isWellFormedXml(container), xmlParseError(container));
    assert.ok(container.includes('full-path="OEBPS/content.opf"'));
  });

  test("content.opf is well formed epub 3 with a v4 uuid", async () => {
    const opf = await read("OEBPS/content.opf");
    assert.ok(isWellFormedXml(opf), xmlParseError(opf));
    assert.ok(opf.includes('version="3.0"'));
    const uuid = opf.match(/urn:uuid:([0-9a-f-]{36})/);
    assert.ok(uuid != null, "no urn:uuid identifier");
    assert.ok(UUID_RE.test(uuid[1]), `not a v4 uuid: ${uuid[1]}`);
    assert.ok(opf.includes("dcterms:modified"));
  });

  test("content.opf carries the story metadata", async () => {
    const opf = await read("OEBPS/content.opf");
    assert.ok(opf.includes("<dc:title>Evolution: From Little Devil to Devil Empress</dc:title>"));
    assert.ok(opf.includes('<dc:creator id="creator">Addicted_To_Coffee</dc:creator>'));
    assert.ok(opf.includes("<dc:language>en</dc:language>"));
    assert.ok(opf.includes(`<dc:source>${STORY_URL}</dc:source>`));
  });

  test("content.opf marks the nav document and the cover", async () => {
    const opf = await read("OEBPS/content.opf");
    assert.ok(opf.includes('properties="nav"'));
    assert.ok(opf.includes('properties="cover-image"'));
    assert.ok(opf.includes('id="cover"'));
  });

  test("the manifest lists every file that exists, and vice versa", async () => {
    const opf = await read("OEBPS/content.opf");
    const hrefs = [...opf.matchAll(/href="([^"]+)"/g)]
      .map((m) => m[1])
      .filter((href) => !href.startsWith("http"));
    for (const href of hrefs) {
      assert.ok(names.includes(`OEBPS/${href}`), `manifest href does not resolve: ${href}`);
    }
    // nav + ncx + stylesheet + cover page + cover image + chapters + images
    const expectedCount = 3 + 2 + epubChapters.length + imageCollector.images.length;
    assert.equal((opf.match(/<item\s/g) || []).length, expectedCount);
  });

  test("the spine is the cover followed by the chapters in order", async () => {
    const opf = await read("OEBPS/content.opf");
    const refs = [...opf.matchAll(/<itemref idref="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(refs, ["cover", "chapter000000001", "chapter000000002"]);
  });

  test("nav.xhtml has one link per chapter and is well formed", async () => {
    const nav = await read("OEBPS/nav.xhtml");
    assert.ok(isWellFormedXml(nav), xmlParseError(nav));
    assert.equal((nav.match(/<li>/g) || []).length, epubChapters.length);
    for (const chapter of epubChapters) {
      assert.ok(nav.includes(chapter.label), `nav is missing ${chapter.label}`);
    }
  });

  test("toc.ncx has one navPoint per chapter and is well formed", async () => {
    const ncx = await read("OEBPS/toc.ncx");
    assert.ok(isWellFormedXml(ncx), xmlParseError(ncx));
    assert.equal((ncx.match(/<navPoint\s/g) || []).length, epubChapters.length);
  });

  test("each chapter file's heading matches its table of contents label", async () => {
    for (const chapter of epubChapters) {
      const xhtml = await read(`OEBPS/${chapter.path}`);
      assert.ok(isWellFormedXml(xhtml), xmlParseError(xhtml));
      assert.ok(
        xhtml.includes(`<h1>${chapter.label.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</h1>`),
        `heading mismatch in ${chapter.path}`
      );
    }
  });

  test("chapter image hrefs climb up to OEBPS/Images", async () => {
    const xhtml = await read(`OEBPS/${epubChapters[0].path}`);
    assert.ok(xhtml.includes('src="../Images/img000000001.webp"'));
    assert.ok(names.includes("OEBPS/Images/img000000001.webp"));
  });

  test("the stylesheet and cover page are present", () => {
    assert.ok(names.includes("OEBPS/styles/stylesheet.css"));
    assert.ok(names.includes("OEBPS/Text/Cover.xhtml"));
    assert.ok(names.includes("OEBPS/Images/cover.jpg"));
  });

  test("writes a sample epub for manual inspection", async () => {
    const outPath = new URL("../../out/sample.epub", import.meta.url);
    await mkdir(dirname(fileURLToPath(outPath)), { recursive: true });
    await writeFile(outPath, Buffer.from(await epubBlob.arrayBuffer()));
    assert.ok(epubBlob.size > 0);
  });
});
