/*
  Drives the real page (pages/app.html + pages/app.js) in a jsdom window.

  The other suites test modules; this one exercises the wiring that only exists
  in the page script: that the story and chapter sections appear, that the
  from/to inputs drive the checkboxes, that the "n of m selected" readout and
  the Create EPUB button follow along, and that All/None/Invert still work.

  Nothing here touches the network: fetch() is stubbed with the same saved
  fenrirealm fixtures the site tests use, and Util.sleep is dropped so the
  parsers' throttle does not slow the run down.
*/

import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import JSZip from "jszip";

const SITE = "fenrirealm";
const STORY_URL = "https://fenrirealm.com/series/absolute-regression";
const PAGE_URL = new URL("../../pages/app.html", import.meta.url);
const APP_JS = new URL("../../pages/app.js", import.meta.url).href;
const { Util } = await import("../../core/Util.js");

/** Chapter numbers the stubbed list returns, in the order the site sends them. */
const LIST_NUMBERS = ["1", "1.5", "2", "3", "4", "5", "6", "Prologue"];

const STORY_HTML = `<!doctype html><html lang="en"><head>
  <title>Absolute Regression - Fenrir Realm</title>
  <meta property="og:site_name" content="Fenrir Realm"/>
  <meta property="og:image" content="https://fenrirealm.com/cover.png"/>
  </head><body>
  <h1 id="series-title">Absolute Regression</h1>
  <div id="series-info"><a href="/user/Fenrirtl">fenrirtl</a></div>
  </body></html>`;

function chapterEntry(number, part, slug) {
  return {
    number,
    part: part ?? null,
    slug: slug ?? String(number),
    title: `Chapter ${number ?? slug}`,
    type: "text",
    locked: { price: 0, unlocked_at: "2025-01-01T00:00:00Z" },
    bought: { wallet_type: null, amount: 0, bought_at: null },
  };
}

/** A chapter that costs seals, bought or not. */
function premiumEntry(number, bought) {
  return {
    ...chapterEntry(number),
    locked: { price: 15, unlocked_at: null, is_read_only: false },
    bought: {
      wallet_type: bought ? "rune" : null,
      amount: bought ? 15 : 0,
      bought_at: bought ? "2026-06-04T15:57:22.000000Z" : null,
    },
  };
}

// shaped like the live API: a part is its own field, and a chapter with no
// number is addressed by its slug
const CHAPTER_LIST = [
  chapterEntry(1), chapterEntry(1, 5), chapterEntry(2), chapterEntry(3),
  chapterEntry(4), chapterEntry(5), chapterEntry(6),
  chapterEntry(null, null, "Prologue"),
];

const $ = (id) => document.getElementById(id);
const tick = (id) => $(id).dispatchEvent(new window.Event("click", { bubbles: true }));
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function serverError() {
  return {
    ok: false,
    status: 500,
    async text() { return ""; },
    async json() { throw new SyntaxError("Unexpected token < in JSON"); },
  };
}

/*
  A chapter as the site actually serves it: a SvelteKit `__data.json` body, read
  as text, with the chapter object reached through devalue's reference table.
*/
function chapterData(title, content) {
  const envelope = {
    type: "data",
    nodes: [{ type: "data", data: [{ chapterData: 1 }, { title, content_format: "html", content }] }],
  };
  return {
    ok: true,
    status: 200,
    async text() { return JSON.stringify(envelope); },
    async json() { return envelope; },
  };
}

function checkboxes() {
  return [...document.querySelectorAll("#chapterList input[type='checkbox']")];
}
function checked() {
  return checkboxes().map((box) => box.checked);
}
function setRange(from, to) {
  $("rangeFrom").value = from;
  $("rangeTo").value = to;
  tick("applyRange");
}
/** Click Create EPUB and wait for the run to report back. */
async function runCreate() {
  tick("createEpubBtn");
  // the download loop is several awaits deep even with sleeps stubbed
  for (let i = 0; i < 80 && !isVisible("resultSection"); ++i) {
    await settle();
  }
  await settle();
}
function datalistValues() {
  return [...$("chapterNumbers").querySelectorAll("option")].map((o) => o.value);
}
function isVisible(id) {
  return !$(id).classList.contains("hidden");
}

let window;
let originalFetch;
let setChapterResponse = () => {};
let setChapterList = () => {};
let realCreateObjectURL;
let realRevokeObjectURL;

before(async () => {
  const html = await readFile(PAGE_URL, "utf8");
  window = new JSDOM(html, { url: `${STORY_URL}?url=${encodeURIComponent(STORY_URL)}` }).window;
  for (const name of [
    "window", "document", "DOMParser", "NodeFilter", "HTMLElement",
    "location", "Blob", "Headers", "FormData",
  ]) {
    globalThis[name] = window[name];
  }
  globalThis.JSZip = JSZip;

  originalFetch = globalThis.fetch;

  // How a chapter URL answers.  Swapped per test to drive the failure handling
  // in the Create EPUB flow; the chapter data route is the one fenrirealm uses.
  let chapterResponder = () => serverError();
  setChapterResponse = (responder) => { chapterResponder = responder; };

  // The list the site returns, swapped by the premium chapter tests.
  let chapterList = CHAPTER_LIST;
  setChapterList = (list) => { chapterList = list; };

  globalThis.fetch = async (rawUrl) => {
    const url = new URL(String(rawUrl));
    if (url.pathname.endsWith("/chapters")) {
      return { ok: true, status: 200, url: url.href, async json() { return chapterList; } };
    }
    if (url.pathname === "/series/absolute-regression") {
      return { ok: true, status: 200, url: url.href, async text() { return STORY_HTML; } };
    }
    return { url: url.href, ...chapterResponder(url) };
  };
  Util.sleep = () => Promise.resolve();

  // Saving the book hands a Blob to URL.createObjectURL and clicks a download
  // link.  Neither does anything in jsdom, and Node's URL.createObjectURL
  // rejects a jsdom Blob outright, so both are stubbed.
  realCreateObjectURL = URL.createObjectURL;
  realRevokeObjectURL = URL.revokeObjectURL;
  URL.createObjectURL = () => "blob:stub";
  URL.revokeObjectURL = () => {};

  // load the page script, then fire the event it waits for
  await import(APP_JS);
  document.dispatchEvent(new window.Event("DOMContentLoaded"));
  await settle();
  await settle();
  setChapterList(CHAPTER_LIST);
  tick("fetchChaptersBtn");
  await settle();
});

beforeEach(() => {
  // each test gets the plain all-free list back, so a premium list set by one
  // test cannot decide what the next one sees
  setChapterList(CHAPTER_LIST);
  setChapterResponse(() => serverError());
});

after(() => {
  globalThis.fetch = originalFetch;
  URL.createObjectURL = realCreateObjectURL;
  URL.revokeObjectURL = realRevokeObjectURL;
});

describe("the page reaches the chapter list", () => {
  test("shows the story card with the extracted metadata", () => {
    assert.equal($("titleInput").value, "Absolute Regression");
    assert.equal($("authorInput").value, "fenrirtl");
    assert.equal($("coverImage").src, "https://fenrirealm.com/cover.png");
  });

  test("shows the chapter list after fetching", () => {
    assert.ok(isVisible("chaptersSection"));
    assert.equal(checkboxes().length, LIST_NUMBERS.length);
    assert.equal($("chapterListTitle").textContent, `${LIST_NUMBERS.length} Chapters`);
  });

  test("starts with everything selected and the button enabled", () => {
    assert.deepEqual(checked(), LIST_NUMBERS.map(() => true));
    assert.equal($("selectionCount").textContent, "8 of 8 selected");
    assert.equal($("createEpubBtn").disabled, false);
  });
});

describe("the from/to inputs", () => {
  test("are prefilled with the first and last chapter", () => {
    assert.equal($("rangeFrom").value, "1");
    assert.equal($("rangeTo").value, "Prologue");
  });

  test("offer every chapter number as a suggestion", () => {
    assert.deepEqual(datalistValues(), LIST_NUMBERS);
  });

  test("select an inclusive range", () => {
    setRange("2", "4");
    assert.deepEqual(checked(), [false, false, true, true, true, false, false, false]);
    assert.equal($("selectionCount").textContent, "3 of 8 selected");
  });

  test("accept a single chapter", () => {
    setRange("3", "3");
    assert.deepEqual(checked(), [false, false, false, true, false, false, false, false]);
    assert.equal($("createEpubBtn").disabled, false);
  });

  test("treat a blank from as the start of the list", () => {
    setRange("", "2");
    assert.deepEqual(checked(), [true, true, true, false, false, false, false, false]);
  });

  test("treat a blank to as the end of the list", () => {
    setRange("4", "");
    assert.deepEqual(checked(), [false, false, false, false, true, true, true, true]);
  });

  test("accept a part number as a bound", () => {
    setRange("1.5", "2");
    assert.deepEqual(checked(), [false, true, true, false, false, false, false, false]);
  });

  test("accept a non numeric bound", () => {
    setRange("Prologue", "Prologue");
    assert.deepEqual(checked(), [false, false, false, false, false, false, false, true]);
  });

  test("swap a reversed range and say so", () => {
    setRange("4", "2");
    assert.deepEqual(checked(), [false, false, true, true, true, false, false, false]);
    assert.match($("rangeStatus").textContent, /Reversed/);
    assert.equal($("rangeStatus").classList.contains("err"), false);
  });

  test("report an unknown bound without discarding the selection", () => {
    setRange("", "3");
    const before = checked();
    setRange("99", "");
    assert.deepEqual(checked(), before, "a typo wiped the user's selection");
    assert.match($("rangeStatus").textContent, /No chapter numbered 99/);
    assert.equal($("rangeStatus").classList.contains("err"), true);
    assert.equal($("rangeFrom").classList.contains("invalid"), true);
    assert.equal($("rangeTo").classList.contains("invalid"), false, "only the box at fault is marked");
  });

  test("mark the to box when the end is the unknown one", () => {
    setRange("1", "banana");
    assert.equal($("rangeTo").classList.contains("invalid"), true);
    assert.equal($("rangeFrom").classList.contains("invalid"), false);
  });

  test("clear the error once a good range is applied", () => {
    setRange("1", "Prologue");
    assert.equal($("rangeStatus").classList.contains("err"), false);
    assert.equal($("rangeFrom").classList.contains("invalid"), false);
    assert.equal($("rangeTo").classList.contains("invalid"), false);
    assert.deepEqual(checked(), LIST_NUMBERS.map(() => true));
  });
});

describe("the selection controls", () => {
  test("ticking a box by hand updates the readout", () => {
    setRange("2", "4");
    const first = checkboxes()[0];
    first.checked = true;
    first.dispatchEvent(new window.Event("change", { bubbles: true }));
    assert.equal($("selectionCount").textContent, "4 of 8 selected");
  });

  test("None clears everything and disables Create EPUB", () => {
    tick("selectNone");
    assert.deepEqual(checked(), LIST_NUMBERS.map(() => false));
    assert.equal($("createEpubBtn").disabled, true);
    assert.equal($("selectionCount").textContent, "none of 8 selected");
  });

  test("All ticks everything and enables Create EPUB", () => {
    tick("selectAll");
    assert.deepEqual(checked(), LIST_NUMBERS.map(() => true));
    assert.equal($("createEpubBtn").disabled, false);
  });

  test("Invert flips every box", () => {
    tick("selectInvert");
    assert.deepEqual(checked(), LIST_NUMBERS.map(() => false));
    assert.equal($("createEpubBtn").disabled, true);
  });
});

/*
  Chapters that cost seals.

  Buying one with a seal in the site's own tab is enough: the extension sends the
  reader's cookies, so the chapter downloads like any other.  What it must not do
  is spend the reader's seals, or quietly throw away chapters they paid for, so
  the premium ones are listed, badged, and left unticked.
*/
describe("premium chapters", () => {
  const PREMIUM_LIST = [
    chapterEntry(1), chapterEntry(2), chapterEntry(3),
    premiumEntry(4, true), premiumEntry(5, false),
  ];

  async function loadPremiumList() {
    setChapterList(PREMIUM_LIST);
    tick("fetchChaptersBtn");
    await settle();
  }

  test("lists every chapter, ticking only the free ones", async () => {
    await loadPremiumList();
    assert.equal(checkboxes().length, 5, "a premium chapter was hidden");
    assert.deepEqual(checked(), [true, true, true, false, false]);
  });

  test("counts the premium chapters in the heading", async () => {
    await loadPremiumList();
    assert.equal($("chapterListTitle").textContent, "5 Chapters (3 free, 2 premium)");
  });

  test("badges an owned premium chapter differently from an unowned one", async () => {
    await loadPremiumList();
    const badges = [...document.querySelectorAll("#chapterList .badge")];
    assert.deepEqual(badges.map((b) => b.textContent), ["premium · owned", "premium"]);
    assert.equal(document.querySelectorAll("#chapterList .badge.owned").length, 1);
    assert.match(badges[0].title, /bought it/);
    assert.match(badges[1].title, /has not bought it/);
  });

  test("says how much of the selection is premium", async () => {
    await loadPremiumList();
    assert.equal($("selectionCount").textContent, "3 of 5 selected");
    const owned = checkboxes()[3];
    owned.checked = true;
    owned.dispatchEvent(new window.Event("change", { bubbles: true }));
    assert.equal($("selectionCount").textContent, "4 of 5 selected (1 premium)");
  });

  test("Free only unticks the premium chapters and keeps the rest", async () => {
    await loadPremiumList();
    tick("selectAll");
    assert.deepEqual(checked(), [true, true, true, true, true]);
    tick("selectFree");
    assert.deepEqual(checked(), [true, true, true, false, false]);
    assert.equal($("createEpubBtn").disabled, false);
  });

  test("All still means all, premium included", async () => {
    await loadPremiumList();
    tick("selectNone");
    tick("selectAll");
    assert.deepEqual(checked(), [true, true, true, true, true]);
  });

  test("a 'to' past the last chapter is taken to the end of the story", async () => {
    await loadPremiumList();
    setRange("2", "1000");
    // an explicit range is taken literally, premium chapters and all
    assert.deepEqual(checked(), [false, true, true, true, true]);
    assert.equal($("rangeStatus").classList.contains("err"), false);
    assert.match($("rangeStatus").textContent, /no chapter 1000/i);
  });

  test("a range warns when it sweeps in premium chapters", async () => {
    await loadPremiumList();
    setRange("1", "5");
    assert.match($("rangeStatus").textContent, /includes 2 premium chapter\(s\)/);
    assert.match($("rangeStatus").textContent, /1 of which this account owns/);
  });

  test("a premium chapter this account owns downloads normally", async () => {
    await loadPremiumList();
    setChapterResponse((url) =>
      url.pathname === "/cover.png"
        ? serverError()
        : chapterData("Chapter 4", "<p>Bought and paid for.</p>")
    );
    checkboxes()[3].checked = true;
    checkboxes()[3].dispatchEvent(new window.Event("change", { bubbles: true }));
    await runCreate();
    assert.equal($("resultTitle").textContent, "Done");
    assert.match($("resultMessage").textContent, /4 chapter\(s\) downloaded/);
    assert.doesNotMatch($("resultMessage").textContent, /failed/);
  });
});

/*
  The Create EPUB flow, driven through the page.

  This is the behaviour that matters when a site is broken: fenrirealm's server
  rendered chapter route is answering every chapter request with a 500, and the
  first version of this happily saved an EPUB whose only page said "this chapter
  could not be downloaded", then reported it as "1 chapter(s)".  These tests pin
  down that a run where nothing downloaded saves nothing and says why.
*/
describe("creating the EPUB while the site is broken", () => {
  function selectOnly(...numbers) {
    const boxes = checkboxes();
    boxes.forEach((box, index) => {
      box.checked = numbers.includes(LIST_NUMBERS[index]);
    });
    boxes[0].dispatchEvent(new window.Event("change", { bubbles: true }));
  }

  test("saves no EPUB when every chapter fails", async () => {
    setChapterResponse(() => serverError());
    selectOnly("1");
    await runCreate();
    assert.ok(isVisible("resultSection"));
    assert.equal($("resultTitle").textContent, "Nothing could be downloaded");
    assert.match($("resultMessage").textContent, /no EPUB was saved/);
    assert.match($("resultMessage").textContent, /site's own server failed/);
    assert.doesNotMatch($("resultMessage").textContent, /EPUB saved/);
  });

  test("still builds a book when only some chapters fail", async () => {
    setChapterResponse((url) => {
      // the cover is a separate request and is allowed to fail here; letting it
      // succeed would hand JSZip a jsdom Blob from a different realm, which is
      // a quirk of the test harness rather than anything the browser does
      if (url.pathname === "/cover.png") return serverError();
      return url.pathname === "/series/absolute-regression/1/__data.json"
        ? chapterData("Chapter 1", "<p>The rain had not stopped for three days.</p>")
        : serverError();
    });
    selectOnly("1", "2");
    await runCreate();
    assert.equal($("resultTitle").textContent, "Completed with errors",
      $("resultMessage").textContent);
    assert.match($("resultMessage").textContent, /1 chapter\(s\) downloaded, 1 failed/);
    assert.match($("resultMessage").textContent, /placeholder page/);
  });
});
