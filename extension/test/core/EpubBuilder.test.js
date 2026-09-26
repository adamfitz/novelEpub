import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { installDom, isWellFormedXml, xmlParseError } from "../helpers/dom.js";

before(() => { installDom(); });

// EpubBuilder is written for the browser where jszip.min.js is a classic
// script defining a global JSZip; expose the npm build the same way.
globalThis.JSZip = JSZip;

const { EpubBuilder } = await import("../../core/EpubBuilder.js");

const META = {
  title: "A Story",
  author: "An Author",
  language: "en",
  description: "About things.",
  publisher: "Example",
  datePublished: "2026-01-02T03:04:05Z",
  tocUrl: "https://example.com/story/",
};

const CHAPTERS = [
  { path: "Text/chapter000000001.xhtml", label: "Chapter 1 - One", xhtml: "<html/>", sourceUrl: "u1" },
  { path: "Text/chapter000000002.xhtml", label: "Chapter 2 - Two", xhtml: "<html/>", sourceUrl: "u2" },
];

const IMAGE = { path: "OEBPS/Images/img000000001.png", blob: new Blob([new Uint8Array([1, 2, 3])]), mediaType: "image/png" };
const COVER = { blob: new Blob([new Uint8Array([4, 5, 6])]), mediaType: "image/jpeg", sourceUrl: "c" };

async function build(overrides = {}) {
  const builder = new EpubBuilder(
    overrides.metaInfo ?? META,
    overrides.chapters ?? CHAPTERS,
    overrides.images ?? [],
    "cover" in overrides ? overrides.cover : null
  );
  return await builder.assemble();
}

async function entries(blob) {
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const names = Object.keys(zip.files);
  const read = (name) => zip.file(name).async("string");
  return { zip, names, read };
}

describe("EpubBuilder archive layout", () => {
  test("puts mimetype first, stored uncompressed", async () => {
    const { zip, names } = await entries(await build());
    assert.equal(names[0], "mimetype");
    assert.equal(await zip.file("mimetype").async("string"), "application/epub+zip");
  });

  test("includes the required container files", async () => {
    const { names } = await entries(await build({ cover: COVER }));
    for (const required of [
      "META-INF/container.xml",
      "OEBPS/content.opf",
      "OEBPS/toc.ncx",
      "OEBPS/nav.xhtml",
      "OEBPS/styles/stylesheet.css",
    ]) {
      assert.ok(names.includes(required), `missing ${required}`);
    }
  });

  test("container.xml points at content.opf and is well formed", async () => {
    const { read } = await entries(await build());
    const container = await read("META-INF/container.xml");
    assert.ok(isWellFormedXml(container), xmlParseError(container));
    assert.ok(container.includes('full-path="OEBPS/content.opf"'));
  });
});

describe("EpubBuilder content.opf", () => {
  test("declares epub 3 with a v4 uuid and dcterms:modified", async () => {
    const { read } = await entries(await build());
    const opf = await read("OEBPS/content.opf");
    assert.ok(opf.includes('version="3.0"'));
    assert.ok(/urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/.test(opf));
    assert.ok(opf.includes("dcterms:modified"));
    assert.ok(isWellFormedXml(opf), xmlParseError(opf));
  });

  test("is stable for the same story so re-downloads match", async () => {
    const first = await build();
    const second = await build();
    const a = await (await entries(first)).read("OEBPS/content.opf");
    const b = await (await entries(second)).read("OEBPS/content.opf");
    const uuid = (opf) => opf.match(/urn:uuid:([0-9a-f-]{36})/)[1];
    assert.equal(uuid(a), uuid(b));
  });

  test("writes the story metadata", async () => {
    const { read } = await entries(await build());
    const opf = await read("OEBPS/content.opf");
    assert.ok(opf.includes("<dc:title>A Story</dc:title>"));
    assert.ok(opf.includes('<dc:creator id="creator">An Author</dc:creator>'));
    assert.ok(opf.includes("<dc:language>en</dc:language>"));
    assert.ok(opf.includes("<dc:publisher>Example</dc:publisher>"));
    assert.ok(opf.includes("<dc:source>https://example.com/story/</dc:source>"));
  });

  test("escapes metadata containing XML syntax", async () => {
    const { read } = await entries(await build({ metaInfo: { ...META, title: "A & B <c>" } }));
    const opf = await read("OEBPS/content.opf");
    assert.ok(opf.includes("<dc:title>A &amp; B &lt;c&gt;</dc:title>"));
    assert.ok(isWellFormedXml(opf), xmlParseError(opf));
  });

  test("every relative manifest href resolves to a file in the zip", async () => {
    const { read, names } = await entries(await build({ images: [IMAGE], cover: COVER }));
    const opf = await read("OEBPS/content.opf");
    for (const [, href] of opf.matchAll(/href="([^"]+)"/g)) {
      if (href.startsWith("http")) continue;
      assert.ok(names.includes(`OEBPS/${href}`), `unresolved manifest href ${href}`);
    }
  });
});

describe("EpubBuilder spine and navigation", () => {
  test("spine holds the cover then the chapters in order", async () => {
    const { read } = await entries(await build({ cover: COVER }));
    const opf = await read("OEBPS/content.opf");
    const refs = [...opf.matchAll(/<itemref idref="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(refs, ["cover", "chapter000000001", "chapter000000002"]);
  });

  test("omits the cover from the spine when there is no cover", async () => {
    const { read } = await entries(await build());
    const opf = await read("OEBPS/content.opf");
    const refs = [...opf.matchAll(/<itemref idref="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(refs, ["chapter000000001", "chapter000000002"]);
    assert.ok(!opf.includes('id="cover"'));
  });

  test("nav.xhtml lists one link per chapter and is well formed", async () => {
    const { read } = await entries(await build());
    const nav = await read("OEBPS/nav.xhtml");
    assert.ok(isWellFormedXml(nav), xmlParseError(nav));
    assert.equal((nav.match(/<li>/g) || []).length, CHAPTERS.length);
    assert.ok(nav.includes("Text/chapter000000001.xhtml"));
    assert.ok(nav.includes("Chapter 2 - Two"));
  });

  test("toc.ncx lists one navPoint per chapter and is well formed", async () => {
    const { read } = await entries(await build());
    const ncx = await read("OEBPS/toc.ncx");
    assert.ok(isWellFormedXml(ncx), xmlParseError(ncx));
    assert.equal((ncx.match(/<navPoint\s/g) || []).length, CHAPTERS.length);
    assert.ok(ncx.includes("Chapter 1 - One"));
  });

  test("escapes a chapter label containing XML syntax", async () => {
    const chapters = [{ ...CHAPTERS[0], label: "A & B <c>" }];
    const { read } = await entries(await build({ chapters }));
    for (const name of ["OEBPS/nav.xhtml", "OEBPS/toc.ncx"]) {
      const doc = await read(name);
      assert.ok(isWellFormedXml(doc), `${name}: ${xmlParseError(doc)}`);
      assert.ok(doc.includes("A &amp; B &lt;c&gt;"));
    }
  });
});

describe("EpubBuilder images and cover", () => {
  test("packs the cover, its page and marks it in the manifest", async () => {
    const { read, names } = await entries(await build({ cover: COVER }));
    const opf = await read("OEBPS/content.opf");
    assert.ok(names.includes("OEBPS/Images/cover.jpg"));
    assert.ok(names.includes("OEBPS/Text/Cover.xhtml"));
    assert.ok(opf.includes('properties="cover-image"'));
    assert.ok(opf.includes('<meta name="cover" content="cover-image"/>'));
  });

  test("keeps a non jpeg cover extension", async () => {
    const png = { ...COVER, mediaType: "image/png" };
    const { names } = await entries(await build({ cover: png }));
    assert.ok(names.includes("OEBPS/Images/cover.png"));
  });

  test("packs inline chapter images", async () => {
    const { names, read } = await entries(await build({ images: [IMAGE] }));
    assert.ok(names.includes("OEBPS/Images/img000000001.png"));
    const opf = await read("OEBPS/content.opf");
    assert.ok(opf.includes('href="Images/img000000001.png" media-type="image/png"'));
  });

  test("manifest item count matches the files added", async () => {
    const { read } = await entries(await build({ images: [IMAGE], cover: COVER }));
    const opf = await read("OEBPS/content.opf");
    // nav + ncx + stylesheet + cover page + cover image + 2 chapters + 1 image
    assert.equal((opf.match(/<item\s/g) || []).length, 8);
  });
});

describe("EpubBuilder edge cases", () => {
  test("builds a valid archive with no chapters at all", async () => {
    const { names, read } = await entries(await build({ chapters: [] }));
    assert.ok(names.includes("OEBPS/content.opf"));
    const opf = await read("OEBPS/content.opf");
    assert.ok(isWellFormedXml(opf), xmlParseError(opf));
    const nav = await read("OEBPS/nav.xhtml");
    assert.ok(isWellFormedXml(nav), xmlParseError(nav));
  });

  test("falls back to Untitled/Unknown/en for missing metadata", async () => {
    const { read } = await entries(await build({ metaInfo: {} }));
    const opf = await read("OEBPS/content.opf");
    assert.ok(opf.includes("<dc:title>Untitled</dc:title>"));
    assert.ok(opf.includes("<dc:creator id=\"creator\">Unknown</dc:creator>"));
    assert.ok(opf.includes("<dc:language>en</dc:language>"));
  });

  test("produces a non empty blob", async () => {
    const blob = await build();
    assert.ok(blob.size > 0);
  });
});
