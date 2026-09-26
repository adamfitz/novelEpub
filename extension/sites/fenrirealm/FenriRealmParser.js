/*
  Site plugin for fenrirealm.com

  The site is a SvelteKit application.  Nothing a scraper needs is in the
  server rendered markup, and the chapter list in particular is only fetched by
  the browser after hydration, so this plugin talks to the same JSON API the
  site's own scripts use.

  Story ("table of contents") page:
      https://fenrirealm.com/series/{slug}
  Its markup does carry the series metadata (an <h1 id="series-title">, an
  author link, og: description / og: image), so metadata is read from the page
  itself with no extra request.

  Chapter list - one request, no pagination, no token:
      GET /api/new/v2/series/{slug}/chapters
  Responds with a JSON array of chapter objects.  Relevant fields:
      number, part, group.slug, id, title, name, type, locked{price,unlocked_at}

  Chapter content comes from the SvelteKit data route rather than the page:

      GET /series/{slug}[/{group}]/{number}[.{part}]/__data.json

  This is the request the site's own reader makes once its app has booted, and
  it is deliberately not the chapter page itself: the server rendered chapter
  route answers HTTP 500 for every chapter at the moment, while this route
  answers 200 with the text.  A site whose SSR is broken still reads fine in a
  browser for exactly this reason, so scraping the data route is both the
  cheaper and the working option.

  The chapter object it carries has a `content` encoded according to
  `content_format`:
      "text"  plain text, paragraphs separated by a blank line
      "html"  an HTML fragment
      "json"  a ProseMirror document tree
      "locked"  the preview is returned instead of the body

  Both "html" and "json" occur in practice on the same series: older chapters
  come back as ProseMirror, newer ones as HTML.

  Chapters the account may not read are skipped: an entry is only readable when
  it is free (`locked.price` 0) or already unlocked (`locked.unlocked_at` set).
  Everything else, including the newest releases on most series, is paid for and
  is left out of the chapter list rather than failing mid-download.
*/

"use strict";

import { Parser } from "../../core/Parser.js";
import { Util, escapeXml } from "../../core/Util.js";
import { proseMirrorToHtml } from "./content.js";
import { SvelteDataError, parseDataResponse } from "./svelteData.js";

const SITE_ORIGIN = "https://fenrirealm.com";
const CHAPTER_LIST_ENDPOINT = "/api/new/v2/series";

/** Marks the element holding a chapter body inside the document we build. */
const CONTENT_CONTAINER_CLASS = "fenr-content";

/** Text the site sends in place of a body it has not finished loading. */
const PENDING_CONTENT = "...";

/*
  Invisible characters the site weaves through its prose.

  The captures contain 1209 clusters of one to four zero-width characters, about
  4200 of them in a single English chapter - roughly a fifth of the file - each
  one sitting just after the first word of a paragraph.  They render as nothing,
  so they are not part of the text a reader sees, but left in they break search
  and copying in the finished book.

  ZWNJ and ZWJ are real characters in Persian, Hindi, Arabic and in emoji
  sequences, so they are only dropped next to printable ASCII, which is where
  this site's clusters sit and where a legitimate joiner in those scripts would
  not.  Zero width space, word joiner and byte order mark carry no meaning in
  prose at any script and go unconditionally.
*/
const INVISIBLE_ANYWHERE = /[\u200B\u2060\uFEFF]/g;
const INVISIBLE_IN_LATIN =
  /(?<=[ -~])[\u200C\u200D]+|[\u200C\u200D]+(?=[ -~])/g;

/*
  Clutter that belongs to fenrirealm.com only.  The base Parser class must never
  hard code selectors from a single site, so everything site specific lives
  here; a change to these strings cannot affect any other plugin.
*/
const CONTENT_SELECTORS_TO_REMOVE = [
  ".novel-epub-exclude",
  "#unlock-chapter",
  "#list-chapter",
  ".reader-area",
  ".reader-attribution",
  "[data-no-doubletap]",
  ".ad",
  ".adsbygoogle",
];

export class FenriRealmParser extends Parser {
  constructor(options = {}) {
    super({ name: "FenrirRealm", minimumThrottle: 500, ...options });
  }

  get contentSelectorsToRemove() {
    return CONTENT_SELECTORS_TO_REMOVE;
  }

  // ---------------------------------------------------------------------------
  // urls
  // ---------------------------------------------------------------------------

  /**
   * The story page for any URL on the site: a chapter page
   * /series/{slug}/{group}/{number} belongs to the series /series/{slug}.
   */
  getTocUrl(url) {
    const slug = seriesSlugFromUrl(url);
    return slug == null ? url : `${SITE_ORIGIN}/series/${slug}`;
  }

  get seriesSlug() {
    return seriesSlugFromUrl(this.tocUrl) ?? seriesSlugFromUrl(globalThis.location?.href);
  }

  // ---------------------------------------------------------------------------
  // story metadata, read from the server rendered story page
  // ---------------------------------------------------------------------------

  extractTitle(dom) {
    const heading = dom.querySelector("#series-title");
    if (heading && heading.textContent.trim()) {
      return heading.textContent.trim();
    }
    const og = dom.querySelector("meta[property='og:title']")?.getAttribute("content");
    if (og) {
      // the site renders "Absolute Regression - Fenrir Realm"
      return og.replace(/\s*-\s*Fenrir Realm\s*$/i, "").trim();
    }
    return super.extractTitle(dom);
  }

  extractAuthor(dom) {
    const link = dom.querySelector("#series-info a[href^='/user/']");
    if (link && link.textContent.trim()) {
      return link.textContent.trim();
    }
    return super.extractAuthor(dom);
  }

  extractCoverImageUrl(dom) {
    const og = dom.querySelector("meta[property='og:image']")?.getAttribute("content");
    if (Util.isUrl(og)) return og;
    return super.extractCoverImageUrl(dom);
  }

  extractDescription(dom) {
    const og = dom.querySelector("meta[property='og:description']")?.getAttribute("content");
    if (og && og.trim()) {
      return og.trim();
    }
    return super.extractDescription(dom);
  }

  extractPublisher(dom) {
    const og = dom.querySelector("meta[property='og:site_name']")?.getAttribute("content");
    return og || "Fenrir Realm";
  }

  extractLanguage() {
    return "en";
  }

  extractDatePublished() {
    return "";
  }

  makeSaveAsFileName() {
    const title = this.metaInfo?.title || "novel";
    return Util.safeForFileName(title, 80) + ".epub";
  }

  // ---------------------------------------------------------------------------
  // chapter list
  // ---------------------------------------------------------------------------

  async getChapterList(dom) { // eslint-disable-line no-unused-vars
    const slug = this.seriesSlug;
    if (slug == null) {
      throw new Error(
        "Unable to determine the series slug from this page.  " +
        "The site layout may have changed."
      );
    }

    const url = new URL(
      `${CHAPTER_LIST_ENDPOINT}/${encodeURIComponent(slug)}/chapters`,
      this.tocUrl || `${SITE_ORIGIN}/`
    );
    const chapters = await this.httpClient.fetchJson(url.href, {
      credentials: "include",
      headers: { "Accept": "application/json" },
      referer: this.tocUrl || `${SITE_ORIGIN}/`,
    });

    if (!Array.isArray(chapters)) {
      throw new Error("The site returned an unexpected chapter list response.");
    }

    const result = [];
    for (const entry of chapters) {
      const chapter = chapterFromApiItem(entry, slug);
      if (chapter != null) {
        result.push(chapter);
      }
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // chapter content
  // ---------------------------------------------------------------------------

  /**
   * The chapter body is read from the site's data route, decoded, and then
   * handed to the shared buildChapterContent(), which keeps the label, cleanup
   * and image localization identical to every other site.
   */
  async fetchChapter(chapter, imageCollector) {
    const dataUrl = dataUrlFor(chapter.sourceUrl);
    const text = await this.httpClient.fetchText(dataUrl, {
      credentials: "include",
      headers: { "Accept": "application/json" },
      referer: chapter.sourceUrl,
    });
    const data = this.chapterDataFrom(text, dataUrl);
    const dom = this.buildChapterDom(data, chapter);
    return this.buildChapterContent(dom, chapter, imageCollector);
  }

  /**
   * Pull the chapter object out of a `__data.json` body, turning the site's
   * other envelopes into messages a reader can act on.
   */
  chapterDataFrom(text, dataUrl) {
    let page;
    try {
      page = parseDataResponse(text, dataUrl);
    } catch (err) {
      if (err instanceof SvelteDataError && err.kind === "redirect") {
        throw new Error(
          `This account cannot read ${chapterLabel(dataUrl)}, so it is not ` +
          `included. If it is a premium chapter, buying it with a seal in the ` +
          `site's own tab unlocks it here too - the cookies are sent with the ` +
          `request. (${err.message})`
        );
      }
      throw err;
    }

    const data = page.chapterData;
    if (data == null || typeof data !== "object") {
      throw new Error(
        `${dataUrl} did not include a chapter object. ` +
        `The site may have changed how it serves chapters.`
      );
    }
    return data;
  }

  /** Wrap a chapter object's body in a document the shared pipeline can use. */
  buildChapterDom(data, chapter) {
    if (data.content_format === "locked") {
      throw new Error(
        `${chapter.sourceUrl} is a paid chapter and was not returned in full.`
      );
    }
    // the placeholder is checked before decoding: it is a stand-in for a body,
    // not a body that happens to be undecodable, and it would otherwise be
    // reported as a parse failure
    const pending = data.content === PENDING_CONTENT;
    if (pending) {
      throw new Error(
        `${chapter.sourceUrl} returned no readable content ` +
        `(the site has not published it yet).`
      );
    }
    const body = stripInvisible(this.bodyToHtml(data, chapter));
    if (body.trim() === "") {
      throw new Error(`${chapter.sourceUrl} returned no readable content.`);
    }
    const title = typeof data.title === "string" ? data.title.trim() : "";
    const dom = Util.parseHtml(
      `<!DOCTYPE html><html lang="en"><head><title>${escapeXml(title)}</title></head>` +
      `<body><div class="${CONTENT_CONTAINER_CLASS}">${body}</div></body></html>`
    );
    if (dom == null) {
      throw new Error(`Failed to build a document for ${chapter.sourceUrl}`);
    }
    return dom;
  }

  /** Decode the body according to the format the site labelled it with. */
  bodyToHtml(data, chapter) {
    const format = data.content_format ??
      (typeof data.content === "string" ? "text" : "json");
    switch (format) {
      case "html":
        return typeof data.content === "string" ? data.content : "";
      case "text":
        return paragraphsToHtml(data.content);
      case "json":
        return proseMirrorToHtml(this.proseMirrorFrom(data.content, chapter));
      default:
        throw new Error(
          `${chapter.sourceUrl} used an unsupported content format "${format}".`
        );
    }
  }

  /**
   * A "json" body arrives as a JSON *string* inside `content`, not as an already
   * parsed tree, so it has to be decoded before it can be walked.  Older
   * chapters on a series are ProseMirror while newer ones are HTML, so getting
   * this wrong silently empties most of a book rather than all of it.
   */
  proseMirrorFrom(content, chapter) {
    if (content != null && typeof content === "object") return content;
    if (typeof content !== "string") {
      throw new Error(
        `${chapter.sourceUrl} labelled its body "json" but sent no document.`
      );
    }
    try {
      return JSON.parse(content);
    } catch {
      throw new Error(
        `${chapter.sourceUrl} sent a body labelled "json" that could not be parsed.`
      );
    }
  }

  findContent(dom) {
    return dom.querySelector(`.${CONTENT_CONTAINER_CLASS}`);
  }

  findChapterTitle(dom, chapter) {
    const heading = dom.querySelector("title")?.textContent?.trim();
    if (heading) return heading;
    return chapter.title?.trim() || null;
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** The {slug} of a /series/{slug}... URL, or null when it is not one. */
export function seriesSlugFromUrl(url) {
  const match = String(url ?? "").match(/\/series\/([A-Za-z0-9._~-]+)/);
  return match == null ? null : match[1];
}

/**
 * Chapter URL as the site builds it: /series/{slug}[/{group}]/{number}[.{part}]
 */
export function chapterPathFor(entry, slug) {
  const group = entry.group?.slug;
  return group
    ? `/series/${slug}/${group}/${chapterNumberFor(entry)}`
    : `/series/${slug}/${chapterNumberFor(entry)}`;
}

/**
 * The SvelteKit data route for a chapter URL.
 *
 * Appended to the same path the reader uses, which keeps the group and part
 * segments that `chapterPathFor()` already built rather than rebuilding them.
 */
export function dataUrlFor(chapterUrl) {
  const url = String(chapterUrl);
  return url.endsWith("/__data.json") ? url : `${url}/__data.json`;
}

/**
 * The number the site itself addresses a chapter by.  A part is part of that
 * identity (/series/s/1.5), so it is kept here too: dropping it would give two
 * different chapters the same "Chapter 1" label and the same ordering key.
 */
export function chapterNumberFor(entry) {
  const number = entry.number ?? entry.slug;
  let path = String(number);
  if (entry.part != null && entry.part !== "") {
    path += `.${entry.part}`;
  }
  return path;
}

/**
 * A chapter that costs seals to read.
 *
 * These stay in the list instead of being filtered out.  The reader may well
 * have bought the one they are looking at, and either way they need to be able
 * to see that it exists and tick it themselves.
 */
export function isPremiumChapter(entry) {
  return entry?.locked?.price > 0;
}

/**
 * Whether this account can expect the body.
 *
 * Spending a seal records the purchase under `bought` but does *not* stamp
 * `locked.unlocked_at`, so treating `unlocked_at` as the only proof of purchase
 * throws away every chapter the reader has actually paid for.  Both are checked.
 */
export function canReadChapter(entry) {
  if (!isPremiumChapter(entry)) return true;
  if (entry.locked.unlocked_at != null) return true;
  return entry.bought?.bought_at != null;
}

function chapterFromApiItem(entry, slug) {
  if (entry == null || typeof entry !== "object") return null;
  if (entry.type != null && entry.type !== "text") {
    // this extension currently targets text based novels
    return null;
  }
  const sourceUrl = new URL(chapterPathFor(entry, slug), SITE_ORIGIN).href;
  const isPremium = isPremiumChapter(entry);
  return {
    sourceUrl,
    chapterNumber: chapterNumberFor(entry),
    title: (entry.title ?? "").trim(),
    id: entry.id,
    language: "en",
    /** costs seals: not ticked by default, and fetched with the reader's cookies */
    isPremium,
    /** this account can read it, which for a premium chapter means it was bought */
    isUnlocked: canReadChapter(entry),
  };
}

/** The chapter a data url belongs to, for a message a reader can act on. */
function chapterLabel(dataUrl) {
  return String(dataUrl).replace(/\/__data\.json$/, "");
}

/** Drop the zero-width characters the site weaves through its prose. */
function stripInvisible(html) {
  return html
    .replace(INVISIBLE_ANYWHERE, "")
    .replace(INVISIBLE_IN_LATIN, "");
}

/** Blank line separated plain text -> paragraphs. */
function paragraphsToHtml(text) {
  if (typeof text !== "string") return "";
  return text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== "")
    .map((paragraph) => `<p>${escapeXml(paragraph).replace(/\n/g, "<br/>")}</p>`)
    .join("");
}
