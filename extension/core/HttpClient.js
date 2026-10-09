/*
  Thin wrapper around fetch() that adds:
    - HTTP error detection
    - a caller configured delay before each request (rate limiting)
    - automatic retries with exponential backoff
  Works in the extension page (Manifest V3 host permissions) and node (test harness).
*/

"use strict";

import { Util } from "./Util.js";

export class HttpError extends Error {
  constructor(message, status, url) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.url = url;
  }
}

const DEFAULT_HEADERS = {
  "Accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
};

/*
  Cloudflare marks: the interstitial page that stands in for a challenged
  request.  Only phrases unique to that interstitial belong here.

  "challenge-platform" and "cf-turnstile" must NOT be listed: Cloudflare
  injects its bot-detection script and a Turnstile widget into perfectly
  normal pages, so matching those would reject every real page the site
  serves.
*/
const CLOUDFLARE_CHALLENGE_MARKERS = [
  "verifying access",
  "Just a moment",
  "Checking your browser before accessing",
  "Enable JavaScript and cookies to continue",
];

function isCloudflareChallenge(text) {
  if (!text || typeof text !== "string") return false;
  // A real chapter or page is large; the interstitial is a small stub.
  if (text.length > 20000) return false;
  return CLOUDFLARE_CHALLENGE_MARKERS.some((marker) => text.includes(marker));
}

export class HttpClient {
  /**
   * @param {object} options
   * @param {number} [options.minimumDelayMs] delay injected before every request
   * @param {number} [options.maxRetries] number of retries after a failure
   * @param {number} [options.timeoutMs] abort a request after this many ms
   */
  constructor(options = {}) {
    this.minimumDelayMs = options.minimumDelayMs ?? 250;
    this.maxRetries = options.maxRetries ?? 4;
    this.timeoutMs = options.timeoutMs ?? 30000;
    this.defaultHeaders = { ...DEFAULT_HEADERS, ...(options.headers || {}) };
  }

  async fetch(url, options = {}) {
    let retries = 0;
    // always leave a polite delay between hits against the same site
    await Util.sleep(this.minimumDelayMs);
    for (;;) {
      try {
        return await this.fetchOnce(url, options);
      } catch (err) {
        const retryable =
          (err instanceof HttpError && err.status >= 500) ||
          (err instanceof Error && err.name === "AbortError") ||
          (!(err instanceof HttpError));
        if (!retryable || retries >= this.maxRetries) {
          throw err;
        }
        ++retries;
        await Util.sleep(500 * Math.pow(2, retries));
      }
    }
  }

  async fetchOnce(url, options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? this.timeoutMs);
    try {
      const headers = { ...this.defaultHeaders, ...(options.headers || {}) };
      const init = {
        method: options.method || "GET",
        headers,
        credentials: options.credentials ?? "include",
        redirect: "follow",
        signal: controller.signal,
        ...(options.body ? { body: options.body } : {}),
      };
      if (options.referer) {
        headers["Referer"] = options.referer;
      }
      const response = await fetch(url, init);
      if (!response.ok) {
        let errText = "";
        try {
          errText = await response.text();
        } catch (_) {
          errText = "";
        }
        if (isCloudflareChallenge(errText)) {
          throw new HttpError(
            `Cloudflare challenge intercepted the request to ${url}. Open the page in your browser, solve the verification if present, and try again.`,
            response.status || 403,
            url
          );
        }
        throw new HttpError(
          `HTTP ${response.status}${reason(response.status)} for ${url}`,
          response.status,
          url
        );
      }
      return response;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Fetch the page as a parsed HTML Document. */
  async fetchDom(url, options = {}) {
    const response = await this.fetch(url, options);
    const html = await response.text();
    if (isCloudflareChallenge(html)) {
      throw new HttpError(
        `Cloudflare challenge intercepted the request to ${url}. Open the page in your browser, solve the verification if present, and try again.`,
        response.status || 403,
        url
      );
    }
    const dom = Util.parseHtml(html);
    if (dom == null) {
      throw new Error(`Failed to parse HTML from ${url}`);
    }
    return dom;
  }

  async fetchJson(url, options = {}) {
    const response = await this.fetch(url, options);
    let text;
    if (typeof response.text === "function") {
      text = await response.text();
    } else if (typeof response.json === "function") {
      try {
        return await response.json();
      } catch (err) {
        throw new HttpError(
          `Received non-JSON response from ${url}. The site may be using Cloudflare protection.`,
          response.status || 0,
          url
        );
      }
    } else {
      text = "";
    }
    if (isCloudflareChallenge(text)) {
      throw new HttpError(
        `Cloudflare challenge intercepted the request to ${url}. Open the page in your browser, solve the verification if present, and try again.`,
        response.status || 403,
        url
      );
    }
    try {
      return JSON.parse(text);
    } catch (err) {
      throw new HttpError(
        `Received non-JSON response from ${url}. The site may be using Cloudflare protection.`,
        response.status || 0,
        url
      );
    }
  }

  async fetchText(url, options = {}) {
    const response = await this.fetch(url, options);
    let text;
    if (typeof response.text === "function") {
      text = await response.text();
    } else {
      text = "";
    }
    if (isCloudflareChallenge(text)) {
      throw new HttpError(
        `Cloudflare challenge intercepted the request to ${url}. Open the page in your browser, solve the verification if present, and try again.`,
        response.status || 403,
        url
      );
    }
    return text;
  }

  async fetchBlob(url, options = {}) {
    const response = await this.fetch(url, options);
    return response.blob();
  }
}

/**
 * A short explanation of a status code, so a failure says something useful.
 *
 * The point is to separate "the site is broken" from "this plugin asked for
 * something wrong", because the fix for the user is completely different: a
 * 5xx or 429 is worth retrying later and is never caused by the request, while
 * a 403 usually means the site started requiring something from us.
 */
function reason(status) {
  if (status === 401 || status === 403) {
    return " (the site refused the request; it may now require being signed in)";
  }
  if (status === 404) {
    return " (the page is gone; the site's layout or chapter list may have changed)";
  }
  if (status === 429) {
    return " (the site is rate limiting; try again later)";
  }
  if (status >= 500) {
    return " (the site's own server failed; this is not a problem with the extension, and it is usually temporary)";
  }
  return "";
}