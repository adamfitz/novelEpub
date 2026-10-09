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
import { ChapterRange } from "../core/ChapterRange.js";
import { Util } from "../core/Util.js";
import { installSiteFetchBridge } from "./siteFetch.js";

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
  // Requests to a supported site go through that site's own page so Cloudflare
  // and the reader's login cookie both see a same-origin request.  This must be
  // installed before any parser makes a request.
  installSiteFetchBridge(parserFactory.supportedHostNames());
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
  $("selectFree").addEventListener("click", setAllChecked);
  $("selectNone").addEventListener("click", setAllChecked);
  $("selectInvert").addEventListener("click", invertChecked);
  $("applyRange").addEventListener("click", applyRange);
  for (const id of ["rangeFrom", "rangeTo"]) {
    $(id).addEventListener("keydown", (event) => {
      if (event.key === "Enter") applyRange();
    });
  }
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
  $("chapterNumbers").replaceChildren();
  $("rangeFrom").value = "";
  $("rangeTo").value = "";
  $("rangeFrom").classList.remove("invalid");
  $("rangeTo").classList.remove("invalid");
  $("rangeStatus").textContent = "";
  $("rangeStatus").classList.remove("err");
  $("selectionCount").textContent = "";
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
    $("chapterListTitle").textContent = chapterListTitle();
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
    // A premium chapter costs the reader seals, so it is never ticked for them.
    // Everything the story gives away is.
    checkbox.checked = !chapter.isPremium;
    checkbox.dataset.index = String(index);
    checkbox.addEventListener("change", updateSelectionState);
    const span = document.createElement("span");
    span.className = "label";
    span.textContent = label;
    item.append(checkbox, span);
    const badge = premiumBadge(chapter);
    if (badge != null) item.appendChild(badge);
    list.appendChild(item);
  });
  renderChapterNumbers();
  const full = ChapterRange.fullRange(state.chapters);
  $("rangeFrom").value = full.from;
  $("rangeTo").value = full.to;
  $("rangeFrom").classList.remove("invalid");
  $("rangeTo").classList.remove("invalid");
  $("rangeStatus").textContent = "";
  $("rangeStatus").classList.remove("err");
  updateSelectionState();
}

/** "premium" on a chapter the account cannot read, "premium · owned" on one it can. */
function premiumBadge(chapter) {
  if (!chapter.isPremium) return null;
  const badge = document.createElement("span");
  badge.className = chapter.isUnlocked ? "badge owned" : "badge premium";
  badge.textContent = chapter.isUnlocked ? "premium · owned" : "premium";
  badge.title = chapter.isUnlocked
    ? "Costs seals. This account has bought it, so it will download."
    : "Costs seals and this account has not bought it. Ticking it will fail " +
      "until it is bought in the site's own tab.";
  return badge;
}

/** Offer the story's own chapter numbers as suggestions. */
function renderChapterNumbers() {
  const datalist = $("chapterNumbers");
  datalist.replaceChildren();
  for (const value of ChapterRange.numbers(state.chapters)) {
    const option = document.createElement("option");
    option.value = value;
    datalist.appendChild(option);
  }
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

/** Tick exactly the chapters the from/to inputs name, leaving the rest alone. */
function applyRange() {
  if (state.chapters.length === 0) return;
  const result = ChapterRange.resolve(
    state.chapters,
    $("rangeFrom").value,
    $("rangeTo").value
  );

  for (const [id, field] of [["rangeFrom", "from"], ["rangeTo", "to"]]) {
    $(id).classList.toggle("invalid", result.invalidField === field);
  }

  if (result.error != null) {
    $("rangeStatus").textContent = result.error;
    $("rangeStatus").classList.add("err");
    return;
  }

  const wanted = new Set(result.chapters);
  for (const checkbox of $("chapterList").querySelectorAll("input[type='checkbox']")) {
    checkbox.checked = wanted.has(state.chapters[Number(checkbox.dataset.index)]);
  }

  // A range is a deliberate request, so it is allowed to include premium
  // chapters - but the reader should know they just asked for 41 of them.
  const premium = result.chapters.filter((chapter) => chapter.isPremium).length;
  const notes = result.warnings.slice();
  if (premium > 0) {
    const owned = result.chapters.filter(
      (chapter) => chapter.isPremium && chapter.isUnlocked
    ).length;
    notes.push(
      `This range includes ${premium} premium chapter(s)` +
      (owned > 0 ? `, ${owned} of which this account owns` : "") + "."
    );
  }

  $("rangeStatus").classList.remove("err");
  $("rangeStatus").textContent = notes.join(" ");
  updateSelectionState();
}

/** "896 Chapters (855 free, 41 premium)", trimmed to just the free count. */
function chapterListTitle() {
  const total = state.chapters.length;
  const premium = state.chapters.filter((chapter) => chapter.isPremium).length;
  const free = total - premium;
  if (premium === 0) return `${total} Chapters`;
  return `${total} Chapters (${free} free, ${premium} premium)`;
}

/** "n of m selected", split so the premium ones among them are visible. */
function updateSelectionState() {
  const total = state.chapters.length;
  const checked = $("chapterList").querySelectorAll("input[type='checkbox']:checked");
  const count = checked.length;
  if (total === 0) {
    $("selectionCount").textContent = "";
  } else if (count === 0) {
    $("selectionCount").textContent = `none of ${total} selected`;
  } else {
    const premium = [...checked].filter(
      (box) => state.chapters[Number(box.dataset.index)].isPremium
    ).length;
    $("selectionCount").textContent =
      `${count} of ${total} selected` + (premium > 0 ? ` (${premium} premium)` : "");
  }
  $("createEpubBtn").disabled = count === 0 || state.running;
}

function setAllChecked(event) {
  const id = event.currentTarget.id;
  for (const box of $("chapterList").querySelectorAll("input[type='checkbox']")) {
    const chapter = state.chapters[Number(box.dataset.index)];
    if (id === "selectAll") {
      box.checked = true;
    } else if (id === "selectFree") {
      // "Free only" unticks the premium chapters without touching the rest,
      // which is the usual way back after selecting everything by accident.
      box.checked = !chapter.isPremium;
    } else {
      box.checked = false;
    }
  }
  updateSelectionState();
}

function invertChecked() {
  for (let checkbox of $("chapterList").querySelectorAll("input[type='checkbox']")) {
    checkbox.checked = !checkbox.checked;
  }
  updateSelectionState();
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
  let downloaded = 0;

  try {
    for (let i = 0; i < selected.length; ++i) {
      const chapter = selected[i];
      updateProgress(i, selected.length, `Chapter ${chapter.chapterNumber || (i + 1)} — ${chapter.sourceUrl}`);
      try {
        const { xhtml, label } = await parser.fetchChapter(chapter, imageCollector);
        epubChapters.push({
          path: `Text/${xhtmlFileName(i)}.xhtml`,
          label,
          xhtml,
          sourceUrl: chapter.sourceUrl,
        });
        downloaded += 1;
      } catch (err) {
        errors.push(`Failed ${chapter.sourceUrl}: ${err.message}`);
        await createPlaceholderChapter(epubChapters, chapter, i, parser, imageCollector);
      }
      updateProgress(i + 1, selected.length, `Chapter ${chapter.chapterNumber || (i + 1)} of ${selected.length} downloaded`);
    }

    // Every chapter failed.  Packing a book whose every page says "this could
    // not be downloaded" helps nobody, and saving it hides the real problem
    // behind a file that looks like a success.
    if (downloaded === 0) {
      showResult(
        "err",
        "Nothing could be downloaded",
        `All ${selected.length} chapter(s) failed, so no EPUB was saved.\n\n` +
        errors.join("\n")
      );
      return;
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

    let resultMessage = `EPUB saved as ${fileName} — ${downloaded} chapter(s) downloaded`;
    if (errors.length > 0) {
      resultMessage += `, ${errors.length} failed`;
      resultMessage += `.\n\nThe ${errors.length} failed chapter(s) are in the book as a placeholder page each, so the table of contents still lines up.\n\n`;
      resultMessage += errors.join("\n");
    } else {
      resultMessage += ".";
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