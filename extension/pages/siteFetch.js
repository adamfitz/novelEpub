/*
  Fan out site requests through the site's own page.

  Cloudflare on fenrirealm.com (and sites behind the same class of protection)
  refuses requests that do not look like they came from the site itself.  A
  fetch() made from the extension page is a cross-site request: the browser
  stamps it with `Origin: chrome-extension://...` and
  `Sec-Fetch-Site: cross-site`, and Cloudflare answers 404 before the request
  ever reaches the application.  Those headers are forbidden, so a script
  cannot rewrite them.

  The way around it is to not make the request from the extension page at all.
  This module installs a wrapper over `fetch` that, for any supported site,
  injects a function into an open tab on that site and lets *that* run the
  fetch.  A fetch from inside the page is same-origin, so it carries the
  reader's login cookie and the Cloudflare clearance cookie, and Cloudflare
  treats it like the reader clicking a link.  The result is serialized back.

  If anything about that fails - no scripting permission, no tab to use,
  injection refused - it falls back to the normal fetch, which is what the
  Node test harness and any site without protection expect.
*/

"use strict";

/** Cannot reference anything outside itself: it is serialized and injected. */
function injectedFetch(url, init) {
  return (async () => {
    const response = await fetch(url, {
      method: init.method || "GET",
      headers: init.headers || {},
      credentials: init.credentials || "include",
      ...(init.body == null ? {} : { body: init.body }),
    });
    const contentType = response.headers.get("content-type") || "";
    const bytes = new Uint8Array(await response.arrayBuffer());
    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      url: response.url,
      contentType,
      base64: btoa(binary),
    };
  })().catch((err) => ({ error: String((err && err.message) || err) }));
}

function bytesFromBase64(base64) {
  const binary = atob(base64 || "");
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function isTextContentType(contentType) {
  return /^(text\/|application\/(json|javascript|xml|xhtml\+xml)|application\/xhtml)/i.test(
    contentType || ""
  );
}

/** Rebuild a fetch Response-like object from what the page sent back. */
function responseFromInjection(result) {
  if (result == null || result.error) {
    throw new Error(
      (result && result.error) || "The site page did not return a response."
    );
  }
  const bytes = bytesFromBase64(result.base64);
  const isText = isTextContentType(result.contentType);
  const headers = new Headers(
    result.contentType ? { "content-type": result.contentType } : {}
  );
  return {
    ok: result.ok,
    status: result.status,
    statusText: result.statusText,
    url: result.url,
    headers,
    async text() {
      return isText ? new TextDecoder().decode(bytes) : "";
    },
    async json() {
      return JSON.parse(new TextDecoder().decode(bytes));
    },
    async blob() {
      return new Blob([bytes], { type: result.contentType || "application/octet-stream" });
    },
    async arrayBuffer() {
      return bytes.buffer;
    },
  };
}

/** A tab on the given host, opened and waited on if none is already there. */
async function tabIdForHost(host) {
  const pattern = `*://${host}/*`;
  const existing = await chrome.tabs.query({ url: pattern }).catch(() => []);
  if (existing.length > 0 && existing[0].id != null) {
    return existing[0].id;
  }
  const created = await chrome.tabs.create({
    url: `https://${host}/`,
    active: false,
  });
  await waitForTabComplete(created.id);
  return created.id;
}

function waitForTabComplete(tabId, timeoutMs = 30000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
  });
}

/**
 * Install the wrapper.  `supportedHostnames` comes from the plugin factory so
 * this file never hard codes a site.
 */
export function installSiteFetchBridge(supportedHostnames) {
  const hosts = new Set((supportedHostnames || []).map((h) => String(h).toLowerCase()));
  const originalFetch = globalThis.fetch.bind(globalThis);
  const usable =
    typeof chrome !== "undefined" &&
    chrome.scripting != null &&
    chrome.tabs != null;

  function hostOf(url) {
    try {
      return new URL(url, globalThis.location?.href || "https://localhost/").hostname.toLowerCase();
    } catch {
      return "";
    }
  }

  function isBridged(url) {
    if (!usable) return false;
    const host = hostOf(url);
    if (host === "") return false;
    for (const supported of hosts) {
      if (host === supported || host.endsWith(`.${supported}`)) return true;
    }
    return false;
  }

  globalThis.fetch = async (input, init = {}) => {
    const rawUrl = typeof input === "string" ? input : input?.url;
    if (!isBridged(rawUrl)) {
      return originalFetch(input, init);
    }
    try {
      const tabId = await tabIdForHost(hostOf(rawUrl));
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: injectedFetch,
        args: [
          String(rawUrl),
          {
            method: init.method || "GET",
            headers: init.headers || {},
            credentials: init.credentials || "include",
            body: init.body ?? null,
          },
        ],
      });
      const result = Array.isArray(results) ? results[0]?.result : null;
      if (result == null) {
        throw new Error("The site page returned nothing.");
      }
      return responseFromInjection(result);
    } catch (err) {
      // A missing tab, a refused injection or a navigation mid-flight should
      // not make the download harder than it already was: try the plain fetch.
      return originalFetch(input, init);
    }
  };

  return { usable };
}
