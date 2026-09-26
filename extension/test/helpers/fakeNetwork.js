/*
  A stubbed network for tests.

  Routes are matched in order; the first match answers.  Every request is
  recorded so a test can assert on the headers, tokens and query parameters a
  plugin sent - which is how the anti-scrape token tests work without ever
  touching the network.
*/

import { Util } from "../../core/Util.js";

/** 1x1 transparent PNG. */
export const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk" +
  "YAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64"
);

/** Minimal JPEG bytes (header only is enough for zip packing). */
export const JPEG_BYTES = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkS" +
  "Ew8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAAL" +
  "CAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAA" +
  "AAD/2gAIAQEAAD8AKp//2Q==",
  "base64"
);

export function htmlResponse(html, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url: "",
    headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
    async text() { return html; },
    async json() { throw new Error("response is not json"); },
    async blob() { return new Blob([html]); },
  };
}

export function jsonResponse(data, status = 200) {
  const text = JSON.stringify(data);
  return {
    ok: status >= 200 && status < 300,
    status,
    url: "",
    headers: new Headers({ "content-type": "application/json" }),
    async text() { return text; },
    async json() { return data; },
    async blob() { return new Blob([text]); },
  };
}

export function imageResponse(bytes, contentType) {
  return {
    ok: true,
    status: 200,
    url: "",
    headers: new Headers({ "content-type": contentType }),
    async text() { return ""; },
    async json() { throw new Error("response is not json"); },
    async blob() { return new Blob([bytes], { type: contentType }); },
  };
}

export function errorResponse(status, body = "") {
  return {
    ok: false,
    status,
    url: "",
    headers: new Headers({ "content-type": "text/plain" }),
    async text() { return body; },
    async json() { throw new Error("response is not json"); },
    async blob() { return new Blob([body]); },
  };
}

/**
 * Build a fetch() replacement.
 * @param {Array<{match: (url: URL, info: object) => boolean, respond: (url: URL, info: object) => object}>} routes
 */
export function createFetchStub(routes) {
  const requests = [];
  const fetchStub = async (rawUrl, init = {}) => {
    const url = new URL(String(rawUrl));
    const info = { headers: normalizeHeaders(init.headers) };
    // recorded because the default, "same-origin", sends no cookies at all on a
    // cross site request, which is what a logged in reader's chapters need
    requests.push({
      url,
      href: String(rawUrl),
      method: init.method || "GET",
      credentials: init.credentials || "same-origin",
      ...info,
    });
    for (const route of routes) {
      if (route.match(url, info)) {
        return route.respond(url, info);
      }
    }
    return errorResponse(404, `no route for ${url.href}`);
  };
  fetchStub.requests = requests;
  return fetchStub;
}

function normalizeHeaders(headers) {
  const result = {};
  if (headers == null) return result;
  if (typeof headers.forEach === "function" && !Array.isArray(headers)) {
    headers.forEach((value, key) => { result[String(key).toLowerCase()] = value; });
    return result;
  }
  for (const [key, value] of Object.entries(headers)) {
    result[key.toLowerCase()] = value;
  }
  return result;
}

/**
 * Replace Util.sleep with a no-op for the duration of a test run, so retry and
 * throttle delays do not slow the suite down.  Returns a restore function.
 */
export function disableSleeps() {
  const original = Util.sleep;
  Util.sleep = () => Promise.resolve();
  return () => { Util.sleep = original; };
}
