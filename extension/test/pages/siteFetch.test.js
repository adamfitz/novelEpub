/*
  Tests for the page fetch bridge (pages/siteFetch.js).

  Cloudflare on a supported site refuses a fetch made from the extension page
  and answers 404, so the bridge is what makes a real download possible.  These
  tests stand in for the browser: a fake `chrome.scripting` runs the injected
  function against a stubbed "page fetch", the way a real page would.
*/

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { installSiteFetchBridge } from "../../pages/siteFetch.js";

let originalFetch;
let originalChrome;
let calls;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalChrome = globalThis.chrome;
  calls = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.chrome = originalChrome;
});

function textResponse(url, body, contentType = "application/json") {
  return {
    ok: true,
    status: 200,
    statusText: "",
    url,
    headers: new Headers({ "content-type": contentType }),
    async arrayBuffer() {
      return new TextEncoder().encode(body).buffer;
    },
  };
}

/**
 * A chrome whose executeScript really runs the injected function, against the
 * given "page" fetch.  A real injected function runs in the page's realm, so
 * this swaps globalThis.fetch for the page stub while it runs and restores it
 * afterwards (which is the wrapper, not the stub).
 */
function fakeChrome({ tab = 7, pageFetch, fail = false } = {}) {
  return {
    tabs: {
      async query() {
        return [{ id: tab }];
      },
      async create() {
        return { id: tab };
      },
      onUpdated: { addListener() {}, removeListener() {} },
    },
    scripting: {
      async executeScript({ func, args }) {
        if (fail) throw new Error("injection refused");
        calls.push({ tab, url: args[0], init: args[1] });
        const wrapper = globalThis.fetch;
        globalThis.fetch = pageFetch;
        try {
          return [{ result: await func(...args) }];
        } finally {
          globalThis.fetch = wrapper;
        }
      },
    },
  };
}

describe("installSiteFetchBridge", () => {
  test("falls back to the plain fetch when chrome is unavailable", async () => {
    let called = 0;
    globalThis.fetch = async () => {
      called += 1;
      return textResponse("https://fenrirealm.com/x", "{}");
    };
    globalThis.chrome = undefined;
    installSiteFetchBridge(["fenrirealm.com"]);
    const res = await globalThis.fetch("https://fenrirealm.com/x");
    assert.equal(called, 1);
    assert.equal(res.status, 200);
  });

  test("routes a supported host through the site page", async () => {
    const pageFetch = async (url) =>
      textResponse(url, '{"hello":1}');
    globalThis.fetch = async () => {
      throw new Error("plain fetch must not be used");
    };
    globalThis.chrome = fakeChrome({ pageFetch });
    installSiteFetchBridge(["fenrirealm.com"]);
    const res = await globalThis.fetch(
      "https://fenrirealm.com/series/absolute-regression/860/__data.json"
    );
    assert.equal(calls.length, 1, "should have gone through the page");
    assert.equal(calls[0].tab, 7);
    assert.deepEqual(await res.json(), { hello: 1 });
  });

  test("does not route an unsupported host", async () => {
    let called = 0;
    globalThis.fetch = async () => {
      called += 1;
      return textResponse("https://example.com/x", "{}");
    };
    globalThis.chrome = fakeChrome({
      pageFetch: async () => {
        throw new Error("must not run");
      },
    });
    installSiteFetchBridge(["fenrirealm.com"]);
    await globalThis.fetch("https://example.com/x");
    assert.equal(called, 1);
    assert.equal(calls.length, 0);
  });

  test("falls back when injection is refused", async () => {
    globalThis.fetch = async (url) => textResponse(String(url), "{}");
    globalThis.chrome = fakeChrome({ fail: true });
    installSiteFetchBridge(["fenrirealm.com"]);
    const res = await globalThis.fetch(
      "https://fenrirealm.com/series/x/__data.json"
    );
    assert.equal(res.status, 200);
  });

  test("rebuilds binary bytes losslessly", async () => {
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 128]);
    const pageFetch = async (url) => ({
      ok: true,
      status: 200,
      statusText: "",
      url,
      headers: new Headers({ "content-type": "image/png" }),
      async arrayBuffer() {
        return png.buffer;
      },
    });
    globalThis.fetch = async () => {
      throw new Error("plain fetch must not be used");
    };
    globalThis.chrome = fakeChrome({ pageFetch });
    installSiteFetchBridge(["fenrirealm.com"]);
    const res = await globalThis.fetch("https://fenrirealm.com/storage/x.png");
    const bytes = new Uint8Array(await res.arrayBuffer());
    assert.deepEqual([...bytes], [...png]);
  });
});
