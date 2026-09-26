/*
  Installs a browser-like DOM onto Node's globals.

  The core modules (Util, Parser, ImageCollector, EpubBuilder) are written for
  the extension page and use DOMParser / NodeFilter / document directly, so a
  jsdom window has to be exposed as globals before they are imported.

  node --test runs every test file in its own process, so each file can call
  this at the top level without leaking globals into other tests.
*/

import { JSDOM } from "jsdom";

/**
 * @param {object} [options]
 * @param {string} [options.url] document URL, used as the base for relative URLs
 */
export function installDom(options = {}) {
  const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
    url: options.url || "https://example.com/",
  });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.DOMParser = dom.window.DOMParser;
  globalThis.NodeFilter = dom.window.NodeFilter;
  globalThis.HTMLElement = dom.window.HTMLElement;
  return dom;
}

/** Parse an XML/XHTML string, throwing when it is not well formed. */
export function parseXml(xml) {
  return new JSDOM(xml, { contentType: "application/xml" });
}

/** True when the string parses as well formed XML. */
export function isWellFormedXml(xml) {
  try {
    parseXml(xml);
    return true;
  } catch (err) {
    return false;
  }
}

/** Describe why a string failed to parse as XML (for assertion messages). */
export function xmlParseError(xml) {
  try {
    parseXml(xml);
    return null;
  } catch (err) {
    return err.message;
  }
}
