/*
  Site plugin for roliascan.com

  Story ("table of contents") page is:
      https://roliascan.com/manga/{slug}/
  Note: the chapter list is NOT part of the story page HTML.  It is loaded
  dynamically into a TAB when the user clicks it, so we call the site's JSON
  API directly:

      GET /auth/manga-chapters?manga_id={id}&offset=0&limit=500&order=ASC&_t={token}&_ts={ts}

  where token = md5(ts + "mng_ch_" + hour).substring(0,16), and hour is the
  current UTC hour as YYYYMMDDhh.  This mirrors the token the site generates in
  assets/js/manga.js.

  A chapter page is:
      https://roliascan.com/read/{slug}/ch{n}-{chapterId}/
  The story text is inside <div class="reader-text"> ... </div> and the site
  renders the chapter heading as <h1>Title… Chapter {n} - Subtitle</h1>.
*/

"use strict";

import { Parser } from "../core/Parser.js";
import { Util } from "../core/Util.js";
import { md5 } from "../core/md5.js";

const CHAPTER_LIST_ENDPOINT = "/auth/manga-chapters";
const CHAPTER_LIST_PAGE_LIMIT = 500;

export class RoliaScansParser extends Parser {
  constructor(options = {}) {
    super({ name: "RoliaScans", minimumThrottle: 300, ...options });
  }

  // ---------------------------------------------------------------------------
  // table of contents
  // ---------------------------------------------------------------------------

  async getChapterList(dom) {
    const mangaId = findMangaId(dom);
    if (mangaId == null) {
      throw new Error(
        "Unable to determine the manga id from this page.  " +
        "The site layout may have changed."
      );
    }

    const chapters = [];
    let offset = 0;
    for (;;) {
      const data = await this.fetchChapterListPage(mangaId, offset);
      if (!data.success) {
        throw new Error("The site rejected the chapter list request.");
      }
      for (let c of data.chapters || []) {
        const chapter = chapterFromApiItem(c);
        if (chapter != null) {
          chapters.push(chapter);
        }
      }
      if (data.has_more && data.chapters?.length > 0) {
        offset += data.chapters.length;
        await this.rateLimitDelay();
      } else {
        break;
      }
    }
    return dedupeChapters(chapters);
  }

  async fetchChapterListPage(mangaId, offset) {
    const { token, timestamp } = generateApiToken();
    const params = new URLSearchParams({
      manga_id: String(mangaId),
      offset: String(offset),
      limit: String(CHAPTER_LIST_PAGE_LIMIT),
      order: "ASC",
      _t: token,
      _ts: String(timestamp),
    });
    const url = new URL(CHAPTER_LIST_ENDPOINT, this.tocUrl || "https://roliascan.com/");
    url.search = params.toString();
    return this.httpClient.fetchJson(url.href, {
      credentials: "include",
      headers: {
        "Accept": "application/json",
        "Referer": this.tocUrl || "https://roliascan.com/",
      },
    });
  }

  // ---------------------------------------------------------------------------
  // chapter page content
  // ---------------------------------------------------------------------------

  findContent(dom) {
    let content = dom.querySelector(".reader-text");
    if (content == null) {
      // fall back to the largest paragraph container on the page
      content = dom.querySelector(".reader .reader-content, .entry-content");
    }
    return content;
  }

  findChapterTitle(dom, chapter) {
    const h1 = dom.querySelector("h1");
    if (h1 == null) return null;
    const text = h1.textContent.replace(/\s+/g, " ").trim();
    // fragment formats seen in the wild:
    //   "… World Chapter 678 - [Ancient Devil—Other Shore]"
    //   "… World Chapter 678"
    const match = text.match(/Chapter\s+\S+\s*[-–—]\s*(.+)$/i);
    if (match) {
      return match[1].trim();
    }
    return null;
  }

  extractCoverImageUrl(dom) {
    const ogImage = dom.querySelector("meta[property='og:image']");
    const url = ogImage?.getAttribute("content");
    if (Util.isUrl(url)) return url;
    return super.extractCoverImageUrl(dom);
  }

  // ---------------------------------------------------------------------------
  // story metadata
  // ---------------------------------------------------------------------------

  extractTitle(dom) {
    const h1 = dom.querySelector("h1");
    if (h1 && h1.textContent.trim()) {
      return h1.textContent.trim();
    }
    return super.extractTitle(dom);
  }

  extractAuthor(dom) {
    const author = extractAuthorFromJsonLd(dom);
    if (author) return author;
    try {
      const node = dom.querySelector("div:has(> div.text-sm.text-neutral-200)");
      if (node) {
        const name = node.querySelector("div.text-sm");
        if (name && name.textContent.trim()) return name.textContent.trim();
      }
    } catch (err) {
      // jsdom does not implement the :has() selector
    }
    return super.extractAuthor(dom);
  }

  extractDescription(dom) {
    const block = dom.querySelector("#description-content-tab p");
    if (block && block.textContent.trim()) {
      return block.textContent.trim();
    }
    return super.extractDescription(dom);
  }

  extractLanguage(dom) {
    return "en";
  }

  extractDatePublished(dom) {
    const meta = dom.querySelector("meta[property='article:published_time']");
    return meta?.getAttribute("content") ?? "";
  }

  makeSaveAsFileName() {
    const title = this.metaInfo?.title || "novel";
    return Util.safeForFileName(title, 80) + ".epub";
  }

  getTocUrl(url) {
    // https://roliascan.com/read/{slug}/ch{n}-{id}/  ->  https://roliascan.com/manga/{slug}/
    const match = String(url).match(/\/read\/([^/]+)\//);
    if (match) {
      return `https://roliascan.com/manga/${match[1]}/`;
    }
    return url;
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function findMangaId(dom) {
  const list = dom.querySelector(".chapter-list[data-manga-id]");
  if (list) return list.getAttribute("data-manga-id");
  const body = dom.querySelector("body[data-manga-id]");
  return body?.getAttribute("data-manga-id") ?? null;
}

function generateApiToken() {
  const timestamp = Math.floor(Date.now() / 1000);
  const hour = new Date().toISOString().slice(0, 13).replace(/[-T:]/g, "");
  const secret = "mng_ch_" + hour;
  const token = md5(timestamp + secret).substring(0, 16);
  return { token, timestamp };
}

function chapterFromApiItem(apiItem) {
  if (!Util.isUrl(apiItem.url)) return null;
  if (apiItem.chapter_type === "images") {
    // this extension currently targets text based novels
    return null;
  }
  return {
    sourceUrl: apiItem.url,
    chapterNumber: apiItem.chapter ?? "",
    title: apiItem.title ?? "",
    id: apiItem.id,
    language: apiItem.language ?? "en",
  };
}

function dedupeChapters(chapters) {
  // avoid duplicate chapter numbers (e.g. multiple scan groups).  Prefer the
  // first entry, giving English text chapters priority.
  const byNumber = new Map();
  const english = new Set();
  const ordered = [];
  for (let chapter of chapters) {
    const key = String(chapter.chapterNumber);
    if (!orderIsStable(ordered, key)) continue;
    if (!byNumber.has(key)) {
      byNumber.set(key, chapter);
      ordered.push(chapter);
      if (chapter.language === "en") {
        english.add(key);
      }
    } else if (!english.has(key) && chapter.language === "en") {
      byNumber.set(key, chapter);
      english.add(key);
    }
  }
  return ordered.map((c) => byNumber.get(String(c.chapterNumber)));
}

function orderIsStable(chapters, key) {
  // The API can return a "-1" chapter marker or out-of-order ids; simply
  // accept anything as long as it hasn't been visited, keeping relative order.
  return !chapters.some((c) => String(c.chapterNumber) === key);
}

function extractAuthorFromJsonLd(dom) {
  for (let entry of Parser.extractJsonLd(dom)) {
    for (let item of expandJsonLd(entry)) {
      if (item.author) {
        if (typeof item.author === "string") return item.author;
        if (item.author.name) return item.author.name;
      }
    }
  }
  return null;
}

function expandJsonLd(node, results) {
  results = results || [];
  if (Array.isArray(node)) {
    for (let item of node) expandJsonLd(item, results);
  } else if (node && typeof node === "object") {
    results.push(node);
    if (node["@graph"]) expandJsonLd(node["@graph"], results);
  }
  return results;
}