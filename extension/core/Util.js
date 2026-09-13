/*
  Generic helpers used throughout the extension.
  Note: this file is written as an ES module and is NOT browser-specific,
  so it can also be imported from the node based test harness.
*/

"use strict";

const XHTML_NS = "http://www.w3.org/1999/xhtml";

export const Util = {
  XHTML_NS,

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  },

  /*
    Parse an HTML string into a DOM document. Returns null on failure.
  */
  parseHtml(html) {
    try {
      return new DOMParser().parseFromString(html, "text/html");
    }
    catch (err) {
      console.error("parseHtml failed", err);
      return null;
    }
  },

  /** Extract the host name (without port) from a URL. */
  extractHostName(url) {
    try {
      return new URL(url).hostname;
    }
    catch (err) {
      return "";
    }
  },

  stripLeadingWww(hostName) {
    return (hostName || "").startsWith("www.") ? hostName.substring(4) : hostName;
  },

  isUrl(url) {
    try {
      const u = new URL(url);
      return (u.protocol === "http:" || u.protocol === "https:");
    }
    catch (err) {
      return false;
    }
  },

  /** Resolve a possibly-relative URL against a base URL. */
  absoluteUrl(baseUrl, url) {
    try {
      return new URL(url, baseUrl).href;
    }
    catch (err) {
      return url;
    }
  },

  isNullOrEmpty(value) {
    return (value == null) || (value.length === 0);
  },

  isNodeWhitespace(node) {
    return (node.nodeType === 3) && (node.textContent.trim().length === 0);
  },

  /** True if the element (or its visible text/content) is empty. */
  isElementWhiteSpace(element) {
    if (element == null) return true;
    const text = (element.textContent || "").trim();
    if (text.length > 0) return false;
    // image/figure elements are content even when they hold no text
    if (["IMG", "PICTURE", "HR", "BR", "SVG", "CANVAS", "IFRAME"].includes(element.tagName)) {
      return false;
    }
    const images = element.querySelectorAll("img").length;
    return images === 0;
  },

  removeElements(elements) {
    for (let element of [...elements]) {
      element.remove();
    }
  },

  removeComments(element) {
    let walker = element.ownerDocument.createTreeWalker(
      element,
      NodeFilter.SHOW_COMMENT
    );
    let nodes = [];
    while (walker.nextNode()) {
      nodes.push(walker.currentNode);
    }
    for (let n of nodes) {
      n.remove();
    }
  },

  removeScriptableElements(element) {
    removeElementsBySelector(element, "script, style, link, meta, iframe");
  },

  removeElementsBySelector(element, selector) {
    Util.removeElements(element.querySelectorAll(selector));
  },

  /*
    Serialize an element subtree into a well-formed XHTML fragment string.

    The element should have been created in a text/html document. We read
    innerHTML (which the HTML parser has already made well balanced and
    escaped) and then apply the small set of fixes required to make the
    fragment valid XML as well:
      - HTML void elements must use the self closing <tag/> form.
      - and the ampersand that can legitimately appear in attribute values
        (hard to generate, but cheap to guard against).

    The result is guaranteed to parse with DOMParser("application/xhtml+xml").
  */
  toWellFormedXhtmlFragment(contentElement) {
    if (contentElement == null) {
      return "";
    }
    let fragment = contentElement.innerHTML;

    fragment = fragment.replace(/<br\s*\/?\s*>/gi, "<br/>");
    fragment = fragment.replace(/<hr\s*\/?\s*>/gi, "<hr/>");
    fragment = fragment.replace(/<img\b([^>]*?)\/?>/gi, (match, attrs) => {
      if (/\/$/.test(match.trim())) {
        return match;
      }
      return `<img ${attrs.trim()}/>`;
    });

    return fragment;
  },

  /*
    Build the complete XHTML document for a single EPUB chapter.
    @returns full XHTML document string
  */
  makeChapterXhtml(title, contentFragment, language, chapterIndex) {
    const shortTitle = escapeXml(title);
    const cssHref = makeRelativePath(stylesheetFileName());
    return (
      `<?xml version="1.0" encoding="utf-8"?>\n` +
      `<!DOCTYPE html>\n` +
      `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${escapeXml(language)}" lang="${escapeXml(language)}">\n` +
      `<head>\n` +
      `  <title>${shortTitle}</title>\n` +
      `  <link rel="stylesheet" type="text/css" href="${cssHref}" title="Default Style"/>\n` +
      `  <meta charset="utf-8"/>\n` +
      `</head>\n` +
      `<body>\n` +
      `  <h1>${shortTitle}</h1>\n` +
      `  <div class="${EPUB_CONTENT_CLASS_NAME}" id="chapter${chapterIndex}">\n` +
      contentFragment +
      `  </div>\n` +
      `</body>\n` +
      `</html>\n`
    );
  },

  /** Make an empty XHTML document that has the standard stylesheet link. */
  makeEmptyXhtmlDoc() {
    const doc = document.implementation.createDocument(XHTML_NS, "html", null);
    const html = doc.documentElement;
    const head = doc.createElementNS(XHTML_NS, "head");
    html.appendChild(head);
    const title = doc.createElementNS(XHTML_NS, "title");
    title.textContent = "";
    head.appendChild(title);
    const link = doc.createElementNS(XHTML_NS, "link");
    link.setAttribute("href", makeRelativePath(stylesheetFileName()));
    link.setAttribute("type", "text/css");
    link.setAttribute("rel", "stylesheet");
    head.appendChild(link);
    const body = doc.createElementNS(XHTML_NS, "body");
    html.appendChild(body);
    return doc;
  },

  /** Extract the title of a chapter from the DOM (uses <title>). */
  extractDomTitle(dom) {
    const title = dom.querySelector("meta[property='og:title']");
    return (title === null) ? dom.title : title.getAttribute("content");
  },

  safeForFileName(fileName, maxLength) {
    let result = fileName.replace(/[\u0000-\u001f\\\/:*?"<>|]/g, "_");
    if (maxLength > 0 && result.length > maxLength) {
      result = result.substring(0, maxLength);
    }
    return result;
  },

  /** Pad a number with leading zeros so lexical ordering matches numeric order. */
  zeroPad(value) {
    const pad = "000000000";
    let s = String(value);
    return pad.substring(0, pad.length - s.length) + s;
  },

  /** Make a URL relative to OEBPS/ (the folder that holds content.opf). */
  makeRelativeToOebps(path) {
    return path.replace(/^OEBPS\//, "");
  },

  xmlToString(doc) {
    return new XMLSerializer().serializeToString(doc);
  },

  extensionVersion() {
    return globalThis.chrome?.runtime?.getManifest?.()?.version ?? "dev";
  },
};

export const EPUB_CONTENT_CLASS_NAME = "novel-epub-content";

export function escapeXml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function stylesheetFileName() {
  return "OEBPS/styles/stylesheet.css";
}

function makeRelativePath(href) {
  return href.replace(/^OEBPS\//, "../");
}

function removeElementsBySelector(element, selector) {
  Util.removeElements(element.querySelectorAll(selector));
}