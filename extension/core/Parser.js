/*
  Base class for site parsers.  New sites are added by subclassing this and
  registering the subclass with ParserFactory, e.g.

      class MySiteParser extends Parser { ... }
      parserFactory.register("mysite.com", () => new MySiteParser());

  A site parser provides three capabilities:

  1. Metadata extraction
     extractTitle / extractAuthor / extractLanguage / extractCoverImageUrl /
     extractDescription / extractPublisher / extractDatePublished / extractSeriesName

  2. A chapter list
     getChapterList(dom) returns an array of:
       { sourceUrl, chapterNumber, title }
     Where:
       sourceUrl     the URL of the chapter page
       chapterNumber a string that orders chapters (e.g. "678")
       title         the per-chapter title the site gives it (may be "")

  3. Chapter content extraction
     findContent(dom) returns the DOM element that holds the story text of a
     chapter page.  The chapter title may be obtained from findChapterTitle().

  Subclasses only need to override the parts above; everything else in this
  class is a sensible default that produces clean, well formed XHTML ready to
  be packed into an EPUB.
*/

"use strict";

import { HttpClient } from "./HttpClient.js";
import { Util } from "./Util.js";

export class Parser {
  constructor(options = {}) {
    this.name = options.name || "Parser";
    this.minimumThrottle = options.minimumThrottle ?? 250;
    this.httpClient =
      options.httpClient ||
      new HttpClient({ minimumDelayMs: this.minimumThrottle });
    // filled in by the UI flow
    this.metaInfo = null;
    this.tocUrl = null;
  }

  // ---------------------------------------------------------------------------
  // Metadata extractors - override as needed
  // ---------------------------------------------------------------------------

  extractTitle(dom) {
    const candidate = dom.querySelector("meta[property='og:title']");
    if (candidate != null) {
      let title = candidate.getAttribute("content");
      if (title) return title.trim();
    }
    return (dom.title || "").trim();
  }

  extractAuthor(dom) { // eslint-disable-line no-unused-vars
    return "";
  }

  extractLanguage(dom) {
    if (dom == null) return "en";
    let locale = dom.querySelector("meta[property='og:locale']");
    if (locale != null && locale.getAttribute("content")) {
      return locale.getAttribute("content").substring(0, 2);
    }
    const htmlLang = dom.querySelector("html")?.getAttribute("lang") ?? "en";
    return htmlLang.split("-")[0];
  }

  extractCoverImageUrl(dom) { // eslint-disable-line no-unused-vars
    return null;
  }

  extractDescription(dom) {
    const meta = dom.querySelector("meta[name='description']");
    return meta?.getAttribute("content")?.trim() ?? "";
  }

  extractPublisher(dom) {
    const meta = dom.querySelector("meta[property='og:site_name']");
    return meta?.getAttribute("content") ?? "";
  }

  extractDatePublished(dom) {
    const meta = dom.querySelector(
      "meta[property='article:published_time'], time[itemprop='datePublished']"
    );
    return meta?.getAttribute("content") ?? meta?.getAttribute("datetime") ?? "";
  }

  extractSeriesName(dom) { // eslint-disable-line no-unused-vars
    return null;
  }

  /**
   * Combine the extracted metadata into a plain object used to build the EPUB.
   */
  extractMetaInfo(dom) {
    return {
      title: this.extractTitle(dom) || "Untitled",
      author: this.extractAuthor(dom) || "Unknown",
      language: this.extractLanguage(dom) || "en",
      coverImageUrl: this.extractCoverImageUrl(dom),
      description: this.extractDescription(dom),
      publisher: this.extractPublisher(dom),
      datePublished: this.extractDatePublished(dom),
      seriesName: this.extractSeriesName(dom),
      tocUrl: this.tocUrl,
    };
  }

  // ---------------------------------------------------------------------------
  // Chapter list - subclasses must override
  // ---------------------------------------------------------------------------

  /**
   * @param {Document} dom of the story page (the "table of contents" page)
   * @returns {Promise<Array<{sourceUrl: string, chapterNumber: string, title: string}>>}
   */
  async getChapterList(dom) { // eslint-disable-line no-unused-vars
    throw new Error(`${this.name} does not implement getChapterList()`);
  }

  // ---------------------------------------------------------------------------
  // Chapter content - subclasses must override findContent()
  // ---------------------------------------------------------------------------

  /**
   * Find the element in a chapter page DOM that holds the story text.
   * @param {Document} dom of an individual chapter page
   * @returns {HTMLElement|null}
   */
  findContent(dom) { // eslint-disable-line no-unused-vars
    return null;
  }

  /**
   * @param {Document} dom of an individual chapter page
   * @param {object} chapter the list item for this chapter
   * @returns {string|null} the page specific chapter title, or null
   */
  findChapterTitle(dom, chapter) { // eslint-disable-line no-unused-vars
    return null;
  }

  /**
   * Build the human readable label used both as the <h1> heading and the
   * table of contents entry for a chapter: "Chapter {n} - {title}".
   * The page specific heading (findChapterTitle) is preferred over the list
   * entry title.  Site parsers that return a full heading from findChapterTitle
   * should strip any leading "Chapter {n}" so the label does not repeat it.
   */
  makeChapterLabel(dom, chapter) {
    let label = "";
    if (chapter.chapterNumber != null && chapter.chapterNumber !== "") {
      label = `Chapter ${chapter.chapterNumber}`;
    }
    const subTitle = this.findChapterTitle(dom, chapter)?.trim() ||
                     chapter.title?.trim() || "";
    if (subTitle !== "") {
      label = label === "" ? subTitle : `${label} - ${subTitle}`;
    }
    return label || (chapter.sourceUrl || "Chapter").trim();
  }

  /**
   * Label used for chapter list entries before the chapters are downloaded
   * (does not require the chapter DOM).
   */
  makeListLabel(chapter) {
    let label = "";
    if (chapter.chapterNumber != null && chapter.chapterNumber !== "") {
      label = `Chapter ${chapter.chapterNumber}`;
    }
    const title = chapter.title?.trim() || "";
    if (title !== "") {
      label = label === "" ? title : `${label} - ${title}`;
    }
    return label || chapter.sourceUrl;
  }

  /**
   * The story (table of contents) page URL for the given current URL.
   * Defaults to the URL itself; overridden for sites where chapter pages and
   * story pages live at different paths.
   */
  getTocUrl(url) {
    return url;
  }

  // ---------------------------------------------------------------------------
  // Content cleaning - reasonable defaults, overridable
  // ---------------------------------------------------------------------------

  /**
   * Turn the raw chapter page into a clean XHTML document fragment.
   * @param {Document} dom of the chapter page
   * @param {object} chapter  list entry, used for title resolution and source
   * @param {object} [imageCollector] optional ImageCollector used to download
   *                 and localize any images found in the chapter content
   * @returns {{xhtml: string, label: string}}
   */
  async buildChapterContent(dom, chapter, imageCollector) {
    let content = this.findContent(dom);
    if (content == null) {
      throw new Error(
        `Unable to find story content in ${chapter.sourceUrl}. ` +
        `The site layout may have changed.`
      );
    }
    content = content.cloneNode(true);
    this.cleanContent(content, dom);
    if (imageCollector != null) {
      await imageCollector.collectImagesInDocument(content, chapter.sourceUrl);
    }
    const label = this.makeChapterLabel(dom, chapter);
    const fragment = Util.toWellFormedXhtmlFragment(content);
    const xhtml = Util.makeChapterXhtml(label, fragment, this.extractLanguage(dom), 0);
    return { xhtml, label };
  }

  /**
   * Default cleanup applied to a cloned chapter content element.
   * Subclasses can extend by calling super then doing extra work.
   */
  cleanContent(content) {
    Util.removeScriptableElements(content);
    Util.removeComments(content);
    Util.removeElementsBySelector(
      content,
      "noscript, input, select, button, iframe, [aria-hidden='true']"
    );
    // swap lazy-load placeholder attributes for the real src
    for (let img of content.querySelectorAll("img")) {
      const lazy = img.getAttribute("data-src") || img.getAttribute("data-lazy-src");
      if (lazy && Util.isUrl(Util.absoluteUrl(img.baseURI, lazy))) {
        img.setAttribute("src", lazy);
      }
      img.removeAttribute("srcset");
      img.removeAttribute("data-src");
      img.removeAttribute("data-lazy-src");
    }
    // remove advertising / site nav container that sometimes wraps novel text
    Util.removeElements(content.querySelectorAll(".novel-epub-exclude"));
    Util.removeElementsBySelector(content, "div.ad, div.ad-container, .adsbygoogle");
    removeEmptyDivs(content);
    removeEmptyAttributes(content);
    removeEmptyWhiteSpaceNodes(content);
    // discard content that is entirely empty (e.g. hentry wrappers)
    for (const child of [...content.children]) {
      if (Util.isElementWhiteSpace(child)) {
        child.remove();
      }
    }
    return content;
  }

  /**
   * Return the cover image URL if one exists for this story.  Defaults to the
   * first image inside the story content, which is what a lot of sites use.
   */
  findCoverImageUrl(dom) {
    const override = this.extractCoverImageUrl(dom);
    if (Util.isUrl(override)) return override;
    const content = this.findContent(dom);
    if (content) {
      const img = content.querySelector("img[src]");
      if (img) return Util.absoluteUrl(dom.baseURI, img.getAttribute("src"));
    }
    return null;
  }

  /**
   * Make a save-as file name for this story.
   */
  makeSaveAsFileName() {
    const title = this.metaInfo?.title || "novel";
    return Util.safeForFileName(title, 80) + ".epub";
  }

  rateLimitDelay() {
    return Util.sleep(this.minimumThrottle);
  }

  static extractJsonLd(dom) {
    const results = [];
    for (let script of dom.querySelectorAll("script[type='application/ld+json']")) {
      try {
        const data = JSON.parse(script.textContent);
        results.push(data);
      } catch (err) { /* ignore malformed JSON-LD */ }
    }
    return results;
  }
}

function removeEmptyDivs(element) {
  for (let div of element.querySelectorAll("div")) {
    if (
      div.childElementCount === 0 &&
      (div.textContent || "").trim() === "" &&
      div.querySelector("img") == null
    ) {
      div.remove();
    }
  }
}

function removeEmptyAttributes(element) {
  for (let e of element.querySelectorAll("*")) {
    for (let attr of [...e.attributes]) {
      if (attr.specified !== false && attr.value === "" && attr.name !== "alt") {
        e.removeAttribute(attr.name);
      }
    }
  }
}

function removeEmptyWhiteSpaceNodes(element) {
  const walker = element.ownerDocument.createTreeWalker(
    element,
    NodeFilter.SHOW_TEXT
  );
  const nodes = [];
  while (walker.nextNode()) {
    nodes.push(walker.currentNode);
  }
  for (let n of nodes) {
    if ((n.textContent || "").trim() === "") {
      n.remove();
    }
  }
}