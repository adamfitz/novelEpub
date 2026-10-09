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

  Chapter content comes from the JSON API the site's reader uses, not from the
  page and not from the SvelteKit data route:

      GET /api/new/v2/series/{slug}[/{group}]/{number}[.{part}]

  A free chapter (locked.price 0) is returned in full, anonymously: the reader
  does not have to be signed in.  The earlier attempt at the SvelteKit
  `__data.json` route was wrong - that route always answers a locked preview,
  which is why every chapter looked paid.

  The chapter object it carries has a `content` encoded according to
  `content_format`:
      "text"  plain text, paragraphs separated by a blank line
      "html"  an HTML fragment
      "json"  a ProseMirror document tree

  Both "html" and "json" occur in practice on the same series: older chapters
  come back as ProseMirror, newer ones as HTML.

  A chapter the account may not read comes back as a short teaser instead: a
  "text" body identical to `excerpt`, with `locked.price` above zero.  That is
  reported as locked rather than written out as a 77 character chapter.  For a
  premium chapter an account token is tried (read off the chapter page) so a
  purchased chapter downloads in full.
*/

"use strict";

import { Parser } from "../../core/Parser.js";
import { Util, escapeXml } from "../../core/Util.js";
import { proseMirrorToHtml } from "./content.js";

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
    /** The account JWT read off the story page, or null when signed out. */
    this.authToken = null;
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

    // The story page is server rendered per session: when the browser is signed
    // in, its inline SvelteKit data carries the account's JWT.  The chapter data
    // route only sends a body when that JWT is presented as a bearer token, so
    // pick it up while the page is in hand.
    const token = authTokenFrom(dom);
    if (token != null) {
      this.authToken = token;
    }

    const url = new URL(
      `${CHAPTER_LIST_ENDPOINT}/${encodeURIComponent(slug)}/chapters`,
      this.tocUrl || `${SITE_ORIGIN}/`
    );
    const chapters = await this.httpClient.fetchJson(url.href, {
      credentials: "include",
      headers: { "Accept": "application/json", "Cache-Control": "no-cache" },
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
   * The chapter body is read from the site's JSON API, decoded, and then
   * handed to the shared buildChapterContent(), which keeps the label, cleanup
   * and image localization identical to every other site.
   */
  async fetchChapter(chapter, imageCollector) {
    const data = await this.fetchChapterData(chapter);
    const dom = this.buildChapterDom(data, chapter);
    return this.buildChapterContent(dom, chapter, imageCollector);
  }

  /**
   * The chapter object from `/api/new/v2/series/{slug}/{number}`.
   *
   * Free chapters need no account at all.  A premium chapter whose body comes
   * back as a teaser is retried once with the account token from the chapter
   * page, so a chapter the reader bought downloads in full.
   */
  async fetchChapterData(chapter) {
    const url = chapterApiUrlFor(chapter.sourceUrl);
    let data = await this.requestChapter(url, chapter, this.authToken);
    if (isLockedPreview(data) && chapter.isPremium && this.authToken == null) {
      const token = await this.tokenFromChapterPage(chapter);
      if (token != null) {
        this.authToken = token;
        data = await this.requestChapter(url, chapter, token);
      }
    }
    return data;
  }

  /** One GET of the chapter API, decoded into the chapter object. */
  async requestChapter(url, chapter, token) {
    const headers = {
      "Accept": "application/json",
      "Cache-Control": "no-cache",
      // the site's reader tells the server it can take protected bodies
      "X-Accepts-Encrypted-Content": "2",
    };
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }
    const data = await this.httpClient.fetchJson(url, {
      credentials: "include",
      headers,
      referer: chapter.sourceUrl,
    });
    if (data == null || typeof data !== "object") {
      throw new Error(
        `${url} did not include a chapter object. ` +
        `The site may have changed how it serves chapters.`
      );
    }
    return data;
  }

  /**
   * The account JWT, read from the chapter page's inline bootstrap data.
   *
   * The story page does not carry it; the chapter page does.  This runs only
   * for a premium chapter whose teaser suggests the account might be allowed to
   * read it, so the extra page request is not paid for ordinary downloads.
   */
  async tokenFromChapterPage(chapter) {
    try {
      const html = await this.httpClient.fetchText(chapter.sourceUrl, {
        credentials: "include",
        headers: { "Accept": "text/html" },
        referer: chapter.sourceUrl,
      });
      return authTokenFrom(Util.parseHtml(html));
    } catch (err) {
      return null;
    }
  }

  /** Wrap a chapter object's body in a document the shared pipeline can use. */
  buildChapterDom(data, chapter) {
    if (data.content_format === "locked" || isLockedPreview(data)) {
      throw new Error(
        `${chapter.sourceUrl} is locked for this account, so its body was not ` +
        `sent. If it is a premium chapter, buy it with a seal in the site's ` +
        `own tab and it downloads here too.`
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

/*
  The account JWT, read off the inline SvelteKit bootstrap data on the chapter
  page.

  Signed in, that data carries `token:"eyJ..."`; signed out it carries
  `token:void 0`.  Other fields happen to be named "token" too - a session flag
  arrives as `token:"session"` - so the value has to look like a JWT (three
  dot separated base64url segments) before it is trusted.  The scan is anchored
  on `isImpersonating`, which sits next to the real token in the bootstrap data.
*/
const JWT_RE = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export function authTokenFrom(dom) {
  if (dom == null || typeof dom.querySelectorAll !== "function") return null;
  for (const script of dom.querySelectorAll("script")) {
    const text = script.textContent || "";
    if (!text.includes("isImpersonating")) continue;
    for (const match of text.matchAll(/token\s*:\s*("(?:[^"\\]|\\.)*")/g)) {
      let value;
      try {
        value = JSON.parse(match[1]);
      } catch {
        continue;
      }
      if (typeof value === "string" && JWT_RE.test(value)) return value;
    }
  }
  return null;
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
 * The JSON API url for a chapter's body: the chapter page path under the
 * `/api/new/v2` prefix, which is the endpoint the site's reader fetches.
 */
export function chapterApiUrlFor(chapterUrl) {
  // the chapter page is /series/{slug}/..., while the API drops that first
  // segment: /api/new/v2/series/{slug}/...
  const path = new URL(String(chapterUrl), SITE_ORIGIN).pathname.replace(/^\/series\//, "/");
  return `${SITE_ORIGIN}${CHAPTER_LIST_ENDPOINT}${path}`;
}

/**
 * Whether a response body is the site's teaser for a chapter it will not send.
 *
 * A refused chapter is not labelled "locked" over this API: it arrives as a
 * short "text" body identical to `excerpt`.  Writing that out would produce a
 * two sentence chapter, so it is treated as locked instead.
 */
export function isLockedPreview(data) {
  if (data == null || typeof data.content !== "string") return false;
  if (data.content_format !== "text") return false;
  const excerpt = typeof data.excerpt === "string" ? data.excerpt.trim() : "";
  if (excerpt === "") return false;
  return data.content.trim() === excerpt;
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
