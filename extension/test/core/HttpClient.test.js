import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { installDom } from "../helpers/dom.js";
import {
  createFetchStub, htmlResponse, jsonResponse, errorResponse, disableSleeps,
} from "../helpers/fakeNetwork.js";

before(() => { installDom(); });

const { HttpClient, HttpError } = await import("../../core/HttpClient.js");

// throttle + backoff delays would make the suite crawl, so stub them out
let restoreSleeps;
before(() => { restoreSleeps = disableSleeps(); });
after(() => { restoreSleeps?.(); });

const HTML = "<!doctype html><html><body><p>ok</p></body></html>";

function clientWith(routes, options = {}) {
  const fetchStub = createFetchStub(routes);
  globalThis.fetch = fetchStub;
  return {
    fetchStub,
    client: new HttpClient({ minimumDelayMs: 0, maxRetries: 0, ...options }),
  };
}

describe("HttpClient.fetch", () => {
  test("returns the response on success", async () => {
    const { client } = clientWith([
      { match: () => true, respond: () => htmlResponse(HTML) },
    ]);
    const response = await client.fetch("https://example.com/a");
    assert.equal(response.ok, true);
    assert.equal(await response.text(), HTML);
  });

  test("sends the default and per request headers, including Referer", async () => {
    const { client, fetchStub } = clientWith([
      { match: () => true, respond: () => htmlResponse(HTML) },
    ]);
    await client.fetch("https://example.com/a", {
      referer: "https://example.com/",
      headers: { "X-Test": "1" },
    });
    const sent = fetchStub.requests[0].headers;
    assert.match(sent.accept, /text\/html/);
    assert.equal(sent["x-test"], "1");
    assert.equal(sent.referer, "https://example.com/");
  });

  test("passes method, credentials and body through", async () => {
    const { client, fetchStub } = clientWith([
      { match: () => true, respond: () => htmlResponse(HTML) },
    ]);
    await client.fetch("https://example.com/a", {
      method: "POST", credentials: "omit", body: "x=1",
    });
    assert.equal(fetchStub.requests[0].method, "POST");
  });

  test("raises HttpError for a non 2xx status", async () => {
    const { client } = clientWith([
      { match: () => true, respond: () => errorResponse(403, "denied") },
    ]);
    await assert.rejects(
      () => client.fetch("https://example.com/a"),
      (err) => {
        assert.ok(err instanceof HttpError);
        assert.equal(err.status, 403);
        assert.match(err.message, /HTTP 403/);
        return true;
      }
    );
  });

  test("explains a 5xx as the site's own failure, not ours", async () => {
    const { client } = clientWith([
      { match: () => true, respond: () => errorResponse(500, "boom") },
    ]);
    await assert.rejects(
      () => client.fetch("https://example.com/a"),
      (err) => {
        assert.match(err.message, /site's own server failed/);
        assert.match(err.message, /not a problem with the extension/);
        return true;
      }
    );
  });

  test("explains a 404 and a 429 and a 403 differently", async () => {
    for (const [status, expected] of [
      [404, /page is gone/],
      [429, /rate limiting/],
      [403, /require being signed in/],
    ]) {
      const { client } = clientWith([
        { match: () => true, respond: () => errorResponse(status, "no") },
      ]);
      await assert.rejects(
        () => client.fetch("https://example.com/a"),
        (err) => {
          assert.match(err.message, expected, `status ${status}`);
          return true;
        }
      );
    }
  });

  test("does not retry a 4xx", async () => {
    const { client, fetchStub } = clientWith(
      [{ match: () => true, respond: () => errorResponse(404) }],
      { maxRetries: 3 }
    );
    await assert.rejects(() => client.fetch("https://example.com/a"));
    assert.equal(fetchStub.requests.length, 1);
  });

  test("retries a 5xx up to maxRetries then gives up", async () => {
    const { client, fetchStub } = clientWith(
      [{ match: () => true, respond: () => errorResponse(503) }],
      { maxRetries: 2 }
    );
    await assert.rejects(() => client.fetch("https://example.com/a"));
    assert.equal(fetchStub.requests.length, 3, "initial attempt + 2 retries");
  });

  test("retries a network failure and succeeds on a later attempt", async () => {
    let calls = 0;
    const { client, fetchStub } = clientWith(
      [{
        match: () => true,
        respond: () => {
          calls += 1;
          if (calls < 3) throw new TypeError("network down");
          return htmlResponse(HTML);
        },
      }],
      { maxRetries: 3 }
    );
    const response = await client.fetch("https://example.com/a");
    assert.equal(await response.text(), HTML);
    assert.equal(fetchStub.requests.length, 3);
  });

  test("stops retrying once maxRetries is exhausted", async () => {
    const { client, fetchStub } = clientWith(
      [{
        match: () => true,
        respond: () => { throw new TypeError("network down"); },
      }],
      { maxRetries: 1 }
    );
    await assert.rejects(() => client.fetch("https://example.com/a"));
    assert.equal(fetchStub.requests.length, 2);
  });
});

describe("HttpClient body helpers", () => {
  test("fetchDom parses HTML into a document", async () => {
    const { client } = clientWith([
      { match: () => true, respond: () => htmlResponse(HTML) },
    ]);
    const dom = await client.fetchDom("https://example.com/a");
    assert.equal(dom.querySelector("p").textContent, "ok");
  });

  test("fetchJson parses JSON", async () => {
    const { client } = clientWith([
      { match: () => true, respond: () => jsonResponse({ a: 1 }) },
    ]);
    assert.deepEqual(await client.fetchJson("https://example.com/a"), { a: 1 });
  });

  test("fetchText returns the raw body", async () => {
    const { client } = clientWith([
      { match: () => true, respond: () => htmlResponse(HTML) },
    ]);
    assert.equal(await client.fetchText("https://example.com/a"), HTML);
  });

  test("fetchBlob returns the bytes", async () => {
    const { client } = clientWith([
      { match: () => true, respond: () => htmlResponse(HTML) },
    ]);
    const blob = await client.fetchBlob("https://example.com/a");
    assert.ok(blob.size > 0);
  });
});
