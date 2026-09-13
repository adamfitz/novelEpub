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
        throw new HttpError(
          `HTTP ${response.status} for ${url}`,
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
    const dom = Util.parseHtml(html);
    if (dom == null) {
      throw new Error(`Failed to parse HTML from ${url}`);
    }
    return dom;
  }

  async fetchJson(url, options = {}) {
    const response = await this.fetch(url, options);
    return response.json();
  }

  async fetchText(url, options = {}) {
    const response = await this.fetch(url, options);
    return response.text();
  }

  async fetchBlob(url, options = {}) {
    const response = await this.fetch(url, options);
    return response.blob();
  }
}