import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { installDom } from "../helpers/dom.js";
import {
  createFetchStub, imageResponse, errorResponse, disableSleeps,
  PNG_BYTES, JPEG_BYTES,
} from "../helpers/fakeNetwork.js";

before(() => { installDom({ url: "https://example.com/novel/chapter-1/" }); });

const { ImageCollector } = await import("../../core/ImageCollector.js");
const { HttpClient } = await import("../../core/HttpClient.js");
const { Util } = await import("../../core/Util.js");

let restoreSleeps;
before(() => { restoreSleeps = disableSleeps(); });
after(() => { restoreSleeps?.(); });

const BASE = "https://example.com/novel/chapter-1/";

/** Build a collector whose network answers from the given routes. */
function collectorWith(routes) {
  const fetchStub = createFetchStub(routes);
  globalThis.fetch = fetchStub;
  const client = new HttpClient({ minimumDelayMs: 0, maxRetries: 0 });
  return { fetchStub, collector: new ImageCollector(client) };
}

/** Parse a chapter content fragment into a detached element. */
function contentWith(html) {
  const dom = Util.parseHtml(`<!doctype html><html><body><div id="c">${html}</div></body></html>`);
  return dom.querySelector("#c");
}

const OK_ROUTES = [
  {
    match: (url) => url.pathname.endsWith("/a.png"),
    respond: () => imageResponse(PNG_BYTES, "image/png"),
  },
  {
    match: (url) => url.pathname.endsWith("/b.webp"),
    respond: () => imageResponse(PNG_BYTES, "image/webp"),
  },
  {
    match: () => true,
    respond: () => imageResponse(JPEG_BYTES, "image/jpeg"),
  },
];

describe("ImageCollector.collectImagesInDocument", () => {
  test("downloads images and rewrites src to a local path", async () => {
    const { collector } = collectorWith(OK_ROUTES);
    const content = contentWith('<img src="https://cdn.test/a.png" alt="a"/>');
    await collector.collectImagesInDocument(content, BASE);
    assert.equal(content.querySelector("img").getAttribute("src"), "../Images/img000000001.png");
    assert.equal(collector.images.length, 1);
    assert.equal(collector.images[0].path, "OEBPS/Images/img000000001.png");
    assert.equal(collector.images[0].mediaType, "image/png");
    assert.equal(collector.images[0].sourceUrl, "https://cdn.test/a.png");
  });

  test("resolves a relative src against the chapter URL", async () => {
    const { collector, fetchStub } = collectorWith([
      { match: () => true, respond: () => imageResponse(PNG_BYTES, "image/png") },
    ]);
    const content = contentWith('<img src="../img/rel.png"/>');
    await collector.collectImagesInDocument(content, BASE);
    assert.equal(
      fetchStub.requests[0].url.href,
      "https://example.com/novel/img/rel.png"
    );
    assert.equal(collector.images.length, 1);
  });

  test("numbers images uniquely in download order", async () => {
    const { collector } = collectorWith(OK_ROUTES);
    const content = contentWith(
      '<img src="https://cdn.test/a.png"/><img src="https://cdn.test/b.webp"/>'
    );
    await collector.collectImagesInDocument(content, BASE);
    assert.deepEqual(
      collector.images.map((i) => i.path),
      ["OEBPS/Images/img000000001.png", "OEBPS/Images/img000000002.webp"]
    );
  });

  test("gives every image a distinct id", async () => {
    const { collector } = collectorWith(OK_ROUTES);
    const content = contentWith('<img src="https://cdn.test/a.png"/><img src="https://cdn.test/b.webp"/>');
    await collector.collectImagesInDocument(content, BASE);
    const ids = collector.images.map((i) => i.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  test("leaves data: URIs inline and downloads nothing for them", async () => {
    const { collector, fetchStub } = collectorWith(OK_ROUTES);
    const tiny = "data:image/png;base64,iVBORw0KGgo=";
    const content = contentWith(`<img src="${tiny}"/>`);
    await collector.collectImagesInDocument(content, BASE);
    assert.equal(collector.images.length, 0);
    assert.equal(fetchStub.requests.length, 0);
    assert.equal(content.querySelector("img").getAttribute("src"), tiny);
  });

  test("keeps the original src when the download fails", async () => {
    const { collector } = collectorWith([
      { match: () => true, respond: () => errorResponse(500) },
    ]);
    const realWarn = console.warn;
    console.warn = () => {};
    const content = contentWith('<img src="https://cdn.test/gone.png"/>');
    try {
      await collector.collectImagesInDocument(content, BASE);
    } finally {
      console.warn = realWarn;
    }
    assert.equal(content.querySelector("img").getAttribute("src"), "https://cdn.test/gone.png");
    assert.equal(collector.images.length, 0);
  });

  test("reports progress for each image", async () => {
    const { collector } = collectorWith(OK_ROUTES);
    const content = contentWith('<img src="https://cdn.test/a.png"/><img src="https://cdn.test/b.webp"/>');
    const seen = [];
    await collector.collectImagesInDocument(content, BASE, (done, total) => seen.push([done, total]));
    assert.deepEqual(seen, [[1, 2], [2, 2]]);
  });

  test("resets back to an empty set of images", async () => {
    const { collector } = collectorWith(OK_ROUTES);
    await collector.collectImagesInDocument(contentWith('<img src="https://cdn.test/a.png"/>'), BASE);
    assert.equal(collector.hasImages(), true);
    collector.reset();
    assert.equal(collector.hasImages(), false);
    assert.equal(collector.images.length, 0);
  });
});

describe("ImageCollector.downloadImage", () => {
  test("returns the bytes and content type", async () => {
    const { collector } = collectorWith(OK_ROUTES);
    const { blob, mediaType } = await collector.downloadImage("https://cdn.test/a.png");
    assert.equal(mediaType, "image/png");
    assert.ok(blob.size > 0);
  });

  test("decodes a data: URI without touching the network", async () => {
    const { collector, fetchStub } = collectorWith(OK_ROUTES);
    const uri = "data:image/png;base64,iVBORw0KGgo=";
    const { blob, mediaType } = await collector.downloadImage(uri);
    assert.equal(mediaType, "image/png");
    assert.ok(blob.size > 0);
    assert.equal(fetchStub.requests.length, 0);
  });

  test("guesses the media type from the extension when the server is vague", async () => {
    const { collector } = collectorWith([
      { match: () => true, respond: () => imageResponse(PNG_BYTES, "application/octet-stream") },
    ]);
    const { mediaType } = await collector.downloadImage("https://cdn.test/pic.webp");
    assert.equal(mediaType, "image/webp");
  });

  test("does not trust a non image content type", async () => {
    const { collector } = collectorWith([
      {
        match: () => true,
        respond: () => ({
          ok: true, status: 200,
          headers: new Headers({ "content-type": "text/html" }),
          async blob() { return new Blob(["<html>blocked</html>"], { type: "text/html" }); },
        }),
      },
    ]);
    const { mediaType } = await collector.downloadImage("https://cdn.test/blocked.png");
    assert.equal(mediaType, "image/png", "falls back to the extension, not text/html");
  });

  test("an application/octet-stream response still yields a valid image type", async () => {
    // the OPF manifest needs a real image/* media type or epubcheck rejects it
    const { collector } = collectorWith([
      { match: () => true, respond: () => imageResponse(PNG_BYTES, "application/octet-stream") },
    ]);
    const { mediaType } = await collector.downloadImage("https://cdn.test/pic.webp");
    assert.equal(mediaType, "image/webp");
  });
});

describe("ImageCollector.localImageName", () => {
  test("maps a media type to a padded file name", () => {
    const { collector } = collectorWith(OK_ROUTES);
    assert.equal(collector.localImageName("image/jpeg"), "img000000001.jpg");
    assert.equal(collector.localImageName("image/webp"), "img000000002.webp");
    assert.equal(collector.localImageName("image/svg+xml"), "img000000003.svg");
  });

  test("falls back to jpg for an unknown media type", () => {
    const { collector } = collectorWith(OK_ROUTES);
    assert.equal(collector.localImageName("application/x-weird"), "img000000001.jpg");
  });
});
