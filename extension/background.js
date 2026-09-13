"use strict";

// Clicking the toolbar button opens the NovelEpub page in a new tab and hands
// it the URL of the tab that was active at that moment.
//
// Opening the UI in a tab instead of a popup means the download keeps running
// when the user switches to other tabs (a popup closes as soon as it loses
// focus, which kills the fetch loop).
chrome.action.onClicked.addListener((tab) => {
  const url = tab != null && tab.url != null ? tab.url : "";
  const pageUrl =
    chrome.runtime.getURL("pages/app.html") +
    "?url=" +
    encodeURIComponent(url);
  chrome.tabs.create({ url: pageUrl });
});