/*
  Main page logic for the NovelEpub tab.

  The toolbar button (background.js) opens this page in a new tab, passing the
  active tab's URL as the ?url= parameter.  A real tab (as opposed to a popup)
  keeps working while the user switches away to other tabs.

  Flow:
    1. read the target URL (from ?url= or the input box)
    2. detect the site plugin, fetch the story page, extract metadata
    3. "Fetch Chapters" -> pull the full chapter list from the site
    4. "Create EPUB" -> download every selected chapter, build a proper EPUB
       and save it.
*/

"use strict";

import { parserFactory } from "../sites/index.js";
import { ImageCollector } from "../core/ImageCollector.js";
import { EpubBuilder } from "../core/EpubBuilder.js";
import { Util } from "../core/Util.js";

const $ = (id) => document.getElementById(id);

const state = {
  parser: null,
  tocUrl: null,
  metaInfo: null,
  chapters: [],
  running: false,
};

document.addEventListener("DOMContentLoaded", async () => {
  $("extensionVersion").textContent = `v${Util.extensionVersion()}`;
  wireButtons();
  await openFromUrlParam();
});

function wireButtons() {
  $("loadUrlBtn").addEventListener("click", () => loadUrl($("urlInput").value));
  $("urlInput").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      loadUrl($("urlInput").value);
    }
  });
  $("fetchChaptersBtn").addEventListener("click", onFetchChaptersClicked);
  $("createEpubBtn").addEventListener("click", onCreateEpubClicked);
  $("titleInput").addEventListener("input", () => {
    state.metaInfo.title = $("titleInput").value;
  });
  $("authorInput").addEventListener("input", () => {
    state.metaInfo.author = $("authorInput").value;
  });
  $("selectAll").addEventListener("click", setAllChecked);
  $("selectNone").addEventListener("click", setAllChecked);
  $("selectInvert").addEventListener("click", invertChecked);
}

// ---------------------------------------------------------------------------
// loading a story URL
// ---------------------------------------------------------------------------

async function openFromUrlParam() {
  const url = new URLSearchParams(location.search).get("url") || "";
  $("urlInput").value = url;
  if (url.trim() === "") {
    showUnsupported("Open a story on a supported site, then click the NovelEpub toolbar button. You can also paste a story or chapter URL above.");
    return;
  }
  await loadUrl(url);
}

async function loadUrl(rawUrl) {
  resetForNewStory();
  const url = rawUrl.trim();
  if (!Util.isUrl(url)) {
    showUnsupported(`"${url}" is not a valid web address.`);
    return;
  }

  const parser = parserFactory.fetchByUrl(url);
  if (parser == null) {
    showUnsupported(`No plugin matches ${hostNameOf(url)} yet.`);
    return;
  }

  state.parser = parser;
  state.tocUrl = parser.getTocUrl(url);
  $("siteBadge").classList.remove("hidden");
  $("siteBadge").textContent = hostNameOf(url);
  showSection("loadingSection");

  try {
    const dom = await parser.httpClient.fetchDom(state.tocUrl, {
      referer: state.tocUrl,
    });
    parser.tocUrl = state.tocUrl;
    state.metaInfo = parser.extractMetaInfo(dom);
    // makeSaveAsFileName() reads parser.metaInfo - share the same object so
    // edits to the title/author inputs are reflected in the file name too
    parser.metaInfo = state.metaInfo;
    renderStoryCard();
    showSection("storySection");
  } catch (err) {
    showUnsupported(`Could not load the story page: ${err.message}`);
  }
}

function resetForNewStory() {
  state.parser = null;
  state.tocUrl = null;
  state.metaInfo = null;
  state.chapters = [];
  state.running = false;
  $("siteBadge").classList.add("hidden");
  $("chapterList").replaceChildren();
  $("createEpubBtn").disabled = true;
  $("progressBar").style.width = "0%";
  showSection("");
}

function renderStoryCard() {
  $("titleInput").value = state.metaInfo.title || "";
  $("authorInput").value = state.metaInfo.author || "";
  $("coverImage").src = state.metaInfo.coverImageUrl || "";
  $("chapterCount").textContent = state.metaInfo.description
    ? state.metaInfo.description.slice(0, 420)
    : "";
}

// ---------------------------------------------------------------------------
// fetch chapter list
// ---------------------------------------------------------------------------

async function onFetchChaptersClicked() {
  const btn = $("fetchChaptersBtn");
  btn.disabled = true;
  btn.textContent = "Fetching…";
  try {
    const dom = await state.parser.httpClient.fetchDom(state.tocUrl, {
      referer: state.tocUrl,
    });
    state.chapters = await state.parser.getChapterList(dom);
    if (state.chapters.length === 0) {
      showResult("err", "No chapters found", "The site returned an empty chapter list.");
      return;
    }
    renderChapterList();
    showSection("chaptersSection");
    $("chapterListTitle").textContent = `${state.chapters.length} Chapters`;
    $("createEpubBtn").disabled = false;
  } catch (err) {
    showResult("err", "Failed to get chapters", err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Fetch Chapters";
  }
}

function renderChapterList() {
  const list = $("chapterList");
  list.replaceChildren();
  state.chapters.forEach((chapter, index) => {
    const label = state.parser.makeListLabel(chapter);
    const item = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = true;
    checkbox.dataset.index = String(index);
    const span = document.createElement("span");
    span.className = "label";
    span.textContent = label;
    item.append(checkbox, span);
    list.appendChild(item);
  });
}

function getSelectedChapters() {
  const selected = [];
  for (let checkbox of $("chapterList").querySelectorAll("input[type='checkbox']")) {
    if (checkbox.checked) {
      selected.push(state.chapters[Number(checkbox.dataset.index)]);
    }
  }
  return selected;
}

function setAllChecked(event) {
  const value = event.currentTarget.id === "selectAll";
  for (let checkbox of $("chapterList").querySelectorAll("input[type='checkbox']")) {
    checkbox.checked = value;
  }
  $("createEpubBtn").disabled = !value;
}

function invertChecked() {
  let anyChecked = false;
  for (let checkbox of $("chapterList").querySelectorAll("input[type='checkbox']")) {
    checkbox.checked = !checkbox.checked;
    anyChecked = anyChecked || checkbox.checked;
  }
  $("createEpubBtn").disabled = !anyChecked;
}

// ---------------------------------------------------------------------------
// download chapters + pack epub
// ---------------------------------------------------------------------------

async function onCreateEpubClicked() {
  const selected = getSelectedChapters();
  if (selected.length === 0 || state.running) return;
  state.running = true;
  $("createEpubBtn").disabled = true;
  $("fetchChaptersBtn").disabled = true;
  showSection("progressSection");
  updateProgress(0, 0, "Preparing…");

  const parser = state.parser;
  const errors = [];
  const imageCollector = new ImageCollector(parser.httpClient);
  const epubChapters = [];

  try {
    for (let i = 0; i < selected.length; ++i) {
      const chapter = selected[i];
      updateProgress(i, selected.length, `Chapter ${chapter.chapterNumber || (i + 1)} — ${chapter.sourceUrl}`);
      try {
        const dom = await parser.httpClient.fetchDom(chapter.sourceUrl, {
          referer: parser.tocUrl,
        });
        const { xhtml, label } = await parser.buildChapterContent(dom, chapter, imageCollector);
        epubChapters.push({
          path: `Text/${xhtmlFileName(i)}.xhtml`,
          label,
          xhtml,
          sourceUrl: chapter.sourceUrl,
        });
      } catch (err) {
        errors.push(`Failed ${chapter.sourceUrl}: ${err.message}`);
        await createPlaceholderChapter(epubChapters, chapter, i, parser, imageCollector);
      }
      updateProgress(i + 1, selected.length, `Chapter ${chapter.chapterNumber || (i + 1)} of ${selected.length} downloaded`);
    }

    updateProgress(selected.length, selected.length, "Downloading cover image…");
    const cover = await fetchCover(parser, imageCollector);

    updateProgress(selected.length, selected.length, "Packing EPUB…");
    const builder = new EpubBuilder(
      state.metaInfo,
      epubChapters,
      imageCollector.images,
      cover
    );
    const blob = await builder.assemble();

    const fileName = parser.makeSaveAsFileName();
    saveBlob(blob, fileName);

    let resultMessage = `EPUB saved as ${fileName} — ${epubChapters.length} chapter(s).`;
    if (errors.length > 0) {
      resultMessage += `\n\n${errors.length} chapter(s) failed:\n` + errors.join("\n");
    }
    showResult(
      errors.length > 0 ? "err" : "ok",
      errors.length > 0 ? "Completed with errors" : "Done",
      resultMessage
    );
  } catch (err) {
    showResult("err", "Failed to create EPUB", err.message);
  } finally {
    state.running = false;
    $("fetchChaptersBtn").disabled = false;
    $("createEpubBtn").disabled = selected.length === 0;
  }
}

async function createPlaceholderChapter(epubChapters, chapter, index, parser, imageCollector) {
  const label = parser.makeListLabel(chapter);
  const message =
    `<p>This chapter could not be downloaded. ` +
    `Please see:<br/><a href="${escapeHtml(chapter.sourceUrl)}">${escapeHtml(chapter.sourceUrl)}</a></p>`;
  const content = document.createElement("div");
  content.innerHTML = message;
  await imageCollector.collectImagesInDocument(content, chapter.sourceUrl).catch(() => {});
  const xhtml = Util.makeChapterXhtml(label, content.innerHTML, parser.extractLanguage({}), 0);
  epubChapters.push({
    path: `Text/${xhtmlFileName(index)}.xhtml`,
    label,
    xhtml,
    sourceUrl: chapter.sourceUrl,
  });
}

async function fetchCover(parser, imageCollector) {
  const coverUrl = state.metaInfo.coverImageUrl;
  if (!Util.isUrl(coverUrl)) return null;
  try {
    const { blob, mediaType } = await imageCollector.downloadImage(coverUrl);
    return { blob, mediaType, sourceUrl: coverUrl };
  } catch (err) {
    console.warn("Cover image download failed", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// misc
// ---------------------------------------------------------------------------

function xhtmlFileName(index) {
  return `chapter${Util.zeroPad(index + 1)}`;
}

function updateProgress(done, total, text) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  $("progressBar").style.width = `${pct}%`;
  $("progressText").textContent = text;
}

function showResult(kind, title, message) {
  const section = $("resultSection");
  section.classList.toggle("ok", kind === "ok");
  section.classList.toggle("err", kind === "err");
  $("resultTitle").textContent = title;
  $("resultMessage").textContent = message;
  showSection("resultSection");
}

function showSection(id) {
  for (let sectionId of [
    "unsupportedSection",
    "loadingSection",
    "storySection",
    "chaptersSection",
    "progressSection",
    "resultSection",
  ]) {
    $(sectionId).classList.toggle("hidden", sectionId !== id);
  }
}

function showUnsupported(message) {
  $("unsupportedMessage").textContent = message;
  $("supportedHosts").textContent = parserFactory.supportedHostNames().join(", ");
  showSection("unsupportedSection");
}

function hostNameOf(url) {
  try {
    const host = new URL(url).hostname;
    return host.startsWith("www.") ? host.substring(4) : host;
  } catch (err) {
    return url;
  }
}

function saveBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}