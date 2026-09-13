/*
  End to end, offline verification of the whole download pipeline.

  It uses the two saved example pages:
      context/roliascan_novel_chapter_list_example.html
      context/roliascan_novel_single_chapter_example.html

  and a fetch() stub so nothing touches the network:

      1. RoliaScansParser.extractMetaInfo  -> story metadata
      2. RoliaScansParser.getChapterList   -> chapter list (paginated API, token)
      3. RoliaScansParser.buildChapterContent + ImageCollector -> clean XHTML + images
      4. EpubBuilder.assemble              -> the EPUB zip
      5. validate every file inside the zip (ordering, xml well formedness,
         manifest/spine/nav/ncx consistency, chapter/image hrefs, uuid format)

  Run with:  npm test   (or node test/make-sample.js)
*/

"use strict";

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import JSZip from "jszip";

import { Util } from "../core/Util.js";
import { RoliaScansParser } from "../sites/RoliaScansParser.js";
import { ImageCollector } from "../core/ImageCollector.js";
import { EpubBuilder } from "../core/EpubBuilder.js";

// EpubBuilder is written for the browser where jszip.min.js is loaded as a
// classic script that defines a global JSZip - expose it for node the same way
globalThis.JSZip = JSZip;

// ---------------------------------------------------------------------------
// node DOM shims used by the (browser-oriented) core modules
// ---------------------------------------------------------------------------

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://roliascan.com/",
});
globalThis.document = dom.window.document;
globalThis.DOMParser = dom.window.DOMParser;
globalThis.NodeFilter = dom.window.NodeFilter;

// ---------------------------------------------------------------------------
// fixtures + a fake network
// ---------------------------------------------------------------------------

const FIXTURES = new URL("../../context/", import.meta.url);

const LIST_HTML = await readFile(
  new URL("roliascan_novel_chapter_list_example.html", FIXTURES),
  "utf8"
);
const CHAPTER_HTML = await readFile(
  new URL("roliascan_novel_single_chapter_example.html", FIXTURES),
  "utf8"
);

// drop a panel image into the reader-text div so the image collection path is
// exercised as well
const CHAPTER_HTML_WITH_IMAGE = CHAPTER_HTML.replace(
  '<div class="reader-text px-4">',
  '<div class="reader-text px-4"><img src="https://roliascan.com/cdn/panelArt.webp" alt="panel"/>'
);

// a 1 x 1 transparent PNG so the image bytes are usable by JSZip
function pngBytes() {
  const base64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk" +
    "YAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
  return Buffer.from(base64, "base64");
}

const TOC_URL = "https://roliascan.com/manga/evolution-from-little-devil-to-devil-empress-novel/";

// canned paginated chapter list - exercises the pagination + dedupe logic
const API_CHAPTERS = [
  buildApiChapter(1, "A New Beginning"),
  buildApiChapter(2, "The River of Oblivion"),
  buildApiChapter(3, "Ancient Devil Say What?"),
  buildApiChapter(3, "Ancient Devil Say What?", "pt"), // duplicate -> should be dropped
  buildApiChapter(4, "[Ancient Devil—Other Shore]"),
  buildApiChapter(5, "System Awakening"),
];

function buildApiChapter(number, title, language = "en") {
  return {
    id: 1000 + number,
    chapter: String(number),
    title,
    date: "2026-09-07T21:00:23+00:00",
    chapter_type: "text",
    group_id: 1,
    language,
    url: `https://roliascan.com/read/evolution-from-little-devil-to-devil-empress-novel/ch${number}-${1000 + number}/`,
  };
}

function chapterListPage(offset) {
  const limit = 2;
  const page = API_CHAPTERS.slice(offset, offset + limit);
  return {
    success: true,
    chapters: page,
    total: 5,
    offset,
    limit,
    has_more: offset + page.length < API_CHAPTERS.length,
  };
}

function makeJson(status, data) {
  return {
    ok: status === 200,
    status,
    async json() { return data; },
    async text() { return JSON.stringify(data); },
    async blob() { return new Uint8Array(0); },
  };
}

function makeHtml(html) {
  return {
    ok: true,
    status: 200,
    async json() { throw new Error("not json"); },
    async text() { return html; },
    async blob() { return new Uint8Array(0); },
  };
}

function makeImage(contentType) {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": contentType }),
    async json() { throw new Error("not json"); },
    async text() { return ""; },
    async blob() { return pngBytes(); },
  };
}

async function fakeFetch(url, init) {
  const target = String(url);
  if (target.includes("/auth/manga-chapters")) {
    const parsed = new URL(target);
    if (parsed.searchParams.get("manga_id") !== "171369") {
      return makeJson(400, { success: false, message: "bad manga id" });
    }
    if (!parsed.searchParams.get("_t") || !parsed.searchParams.get("_ts")) {
      return makeJson(400, { success: false, message: "missing token" });
    }
    return makeJson(200, chapterListPage(Number(parsed.searchParams.get("offset"))));
  }
  if (target.includes("/cd/panelArt.webp") || target.includes("/cdn/panelArt.webp")) {
    return makeImage("image/webp");
  }
  if (target.includes("/content/media/")) {
    return makeImage("image/jpeg");
  }
  if (target.includes("/read/")) {
    return makeHtml(CHAPTER_HTML_WITH_IMAGE);
  }
  if (target.includes("/manga/")) {
    return makeHtml(LIST_HTML);
  }
  return makeJson(404, { success: false, message: `unhandled ${target}` });
}

globalThis.fetch = fakeFetch;

// ---------------------------------------------------------------------------
// tiny test plumbing
// ---------------------------------------------------------------------------

let tests = 0;
let failures = 0;

function assert(condition, message) {
  ++tests;
  if (!condition) {
    ++failures;
    console.error("  FAIL: " + message);
  } else {
    console.log("  ok:   " + message);
  }
}

function assertEqual(actual, expected, message) {
  assert(actual === expected, `${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

async function assertXmlWellFormed(contents, name) {
  assertEqual(typeof contents, "string", `${name} readable as string`);
  try {
    new JSDOM(contents, { contentType: "application/xml" });
    assert(true, `${name} is well formed XML`);
  } catch (err) {
    assert(false, `${name} is well formed XML: ${err.message}`);
  }
}

const uuidRe =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// ---------------------------------------------------------------------------
// 1. metadata
// ---------------------------------------------------------------------------

console.log("\n[1] metadata extraction");
const listDom = Util.parseHtml(LIST_HTML);
const parser = new RoliaScansParser();
parser.tocUrl = TOC_URL;
const metaInfo = parser.extractMetaInfo(listDom);
parser.metaInfo = metaInfo;

assertEqual(metaInfo.title, "Evolution: From Little Devil to Devil Empress", "title");
assertEqual(metaInfo.author, "Addicted_To_Coffee", "author");
assertEqual(metaInfo.language, "en", "language");
assertEqual(metaInfo.publisher, "roliascan.com", "publisher");
assert(
  metaInfo.coverImageUrl &&
    metaInfo.coverImageUrl.startsWith("https://roliascan.com/content/media/"),
  "cover image url"
);
assert(metaInfo.description.length > 50, "description extracted");
assertEqual(metaInfo.tocUrl, TOC_URL, "metaInfo.tocUrl set");
assertEqual(
  parser.makeSaveAsFileName(),
  "Evolution_ From Little Devil to Devil Empress.epub",
  "save-as file name"
);

// ---------------------------------------------------------------------------
// 2. chapter list (paginated API + token + dedupe)
// ---------------------------------------------------------------------------

console.log("\n[2] chapter list");
const chapters = await parser.getChapterList(listDom);
assertEqual(chapters.length, 5, "chapter count after dedupe");
assertEqual(chapters[0].chapterNumber, "1", "first chapter number");
assertEqual(chapters[4].chapterNumber, "5", "last chapter number");
assertEqual(
  parser.makeListLabel(chapters[3]),
  "Chapter 4 - [Ancient Devil—Other Shore]",
  "list label"
);
const numberCount = new Set(chapters.map((c) => String(c.chapterNumber))).size;
assertEqual(numberCount, chapters.length, "no duplicate chapter numbers");

// ---------------------------------------------------------------------------
// 3. chapter content + images
// ---------------------------------------------------------------------------

console.log("\n[3] chapter content");
const imageCollector = new ImageCollector(parser.httpClient);
const epubChapters = [];
for (let i = 0; i < chapters.length; ++i) {
  const chapterDom = Util.parseHtml(CHAPTER_HTML_WITH_IMAGE);
  const { xhtml, label } = await parser.buildChapterContent(chapterDom, chapters[i], imageCollector);
  epubChapters.push({
    path: `Text/chapter${Util.zeroPad(i + 1)}.xhtml`,
    label,
    xhtml,
    sourceUrl: chapters[i].sourceUrl,
  });
}

assertEqual(epubChapters.length, 5, "built 5 chapter xhtml documents");
assertEqual(
  epubChapters[3].label,
  "Chapter 4 - [Ancient Devil—Other Shore]",
  "chapter label uses the page <h1> subtitle"
);
assert(
  !epubChapters[3].xhtml.toLowerCase().includes("<script"),
  "chapter content contains no <script> elements"
);
assert(
  epubChapters[3].xhtml.includes("<p>One of these powers, Liora immediately identified.</p>"),
  "story paragraphs are preserved"
);
assert(epubChapters[3].xhtml.includes('src="../Images/img000000004.webp"'), "chapter 4 image src rewritten to local path");
assertEqual(imageCollector.images.length, 5, "one localized image per chapter");
assertEqual(imageCollector.images[0].path, "OEBPS/Images/img000000001.webp", "image stored path");

// ---------------------------------------------------------------------------
// 4. the cover image
// ---------------------------------------------------------------------------

console.log("\n[4] cover");
const coverDownload = await imageCollector.downloadImage(metaInfo.coverImageUrl);
const cover = { ...coverDownload, sourceUrl: metaInfo.coverImageUrl };
assertEqual(cover.mediaType, "image/jpeg", "cover media type");

// ---------------------------------------------------------------------------
// 5. epub assembly
// ---------------------------------------------------------------------------

console.log("\n[5] epub assembly");
const builder = new EpubBuilder(metaInfo, epubChapters, imageCollector.images, cover);
const blob = await builder.assemble();
assert(blob.size > 0, `assembled epub blob (${blob.size} bytes)`);

const outPath = new URL("../out/sample.epub", import.meta.url);
await mkdir(dirname(fileURLToPath(outPath)), { recursive: true });
await writeFile(outPath, Buffer.from(await blob.arrayBuffer()));
assert(true, `wrote ${outPath}`);
const zip = await JSZip.loadAsync(await blob.arrayBuffer());
const names = Object.keys(zip.files);

// ---------------------------------------------------------------------------
// 6. epub validation
// ---------------------------------------------------------------------------

console.log("\n[6] epub validation");

assertEqual(names[0], "mimetype", "mimetype is the first file in the archive");
assertEqual(
  await zip.file("mimetype").async("string"),
  "application/epub+zip",
  "mimetype contents"
);
assert(names.includes("META-INF/container.xml"), "container.xml present");
assert(!names.includes("__MACOSX"), "no mac metadata");

const container = await zip.file("META-INF/container.xml").async("string");
await assertXmlWellFormed(container, "META-INF/container.xml");
assert(container.includes('full-path="OEBPS/content.opf"'), "container.xml points at content.opf");

const opf = await zip.file("OEBPS/content.opf").async("string");
await assertXmlWellFormed(opf, "OEBPS/content.opf");
assert(opf.includes('version="3.0"'), "opf is epub3");
assert(opf.includes("urn:uuid:"), "opf has a uuid identifier");
const uuidMatch = opf.match(/urn:uuid:([0-9a-f-]{36})/);
assert(uuidMatch != null && uuidRe.test(uuidMatch[1]), "identifier is a well formed uuid v4");
assert(opf.includes("dcterms:modified"), "opf has dcterms:modified");
assert(opf.includes('<dc:title>Evolution: From Little Devil to Devil Empress</dc:title>'), "opf title");
assert(opf.includes('<dc:creator id="creator">Addicted_To_Coffee</dc:creator>'), "opf creator");
assert(opf.includes('<dc:language>en</dc:language>'), "opf language");
assert(opf.includes('<dc:source>') && opf.includes(TOC_URL), "opf source link");
assert(opf.includes('properties="nav"'), "opf manifest marks the nav document");
assert(opf.includes('properties="cover-image"'), "opf manifest marks the cover image");
assert(opf.includes('id="cover"'), "opf manifest has the cover xhtml");

const expectedManifestHeight = 5 + epubChapters.length + imageCollector.images.length;
const manifestItems = (opf.match(/<item\s/g) || []).length;
assertEqual(manifestItems, expectedManifestHeight, "opf manifest item count");

const spineRefs = [...opf.matchAll(/<itemref idref="([^"]+)"/g)].map((m) => m[1]);
assertEqual(spineRefs.length, 1 + epubChapters.length, "spine itemref count (cover + chapters)");
for (const id of ["cover", "chapter000000001", "chapter000000005"]) {
  assert(spineRefs.includes(id), `spine references ${id}`);
}

const nav = await zip.file("OEBPS/nav.xhtml").async("string");
await assertXmlWellFormed(nav, "OEBPS/nav.xhtml");
const tocEntries = (nav.match(/<li>/g) || []).length;
assertEqual(tocEntries, epubChapters.length, "nav.xhtml has one TOC entry per chapter");
for (const entry of ["chapter000000001", "chapter000000005"]) {
  assert(nav.includes(`Text/${entry}.xhtml`), `nav.xhtml links chapter ${entry}`);
}

const ncx = await zip.file("OEBPS/toc.ncx").async("string");
await assertXmlWellFormed(ncx, "OEBPS/toc.ncx");
const navPoints = (ncx.match(/<navPoint\s/g) || []).length;
assertEqual(navPoints, epubChapters.length, "toc.ncx has one navPoint per chapter");
assert(ncx.includes("Chapter 4 - [Ancient Devil—Other Shore]"), "toc.ncx chapter 4 label");

assert(names.includes("OEBPS/styles/stylesheet.css"), "stylesheet present");
assert(names.includes("OEBPS/Text/Cover.xhtml"), "cover xhtml present");
assert(names.includes("OEBPS/Images/cover.jpg"), "cover image present");
assert(names.includes("OEBPS/Images/img000000001.webp"), "localized chapter image present");

const sampleChapter = await zip.file("OEBPS/Text/chapter000000004.xhtml").async("string");
await assertXmlWellFormed(sampleChapter, "OEBPS/Text/chapter000000004.xhtml");
assert(
  sampleChapter.includes("<h1>Chapter 4 - [Ancient Devil—Other Shore]</h1>"),
  "chapter h1 matches the TOC label"
);
assert(sampleChapter.includes('src="../Images/img000000004.webp"'), "chapter image href resolves");

// every manifest href must exist inside the zip
for (const m of opf.matchAll(/href="([^"]+)"/g)) {
  const href = m[1];
  if (href.startsWith("http")) continue;
  assert(names.includes(`OEBPS/${href}`), `manifest href resolves: ${href}`);
}

// ---------------------------------------------------------------------------
console.log(`\n${tests - failures}/${tests} checks passed`);
process.exit(failures === 0 ? 0 : 1);