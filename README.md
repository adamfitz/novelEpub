# NovelEpub

A browser extension that downloads web novels and packs them into properly
structured EPUB 3 files. The site handling is written as small plugins (one
class per site), the same concept as [WebToEpub](https://github.com/dtevik/WebToEpub).

## Features

- Detects the current tab's site and loads the story metadata (title, author,
  cover, description).
- Fetches the complete chapter list for the story.
- Lets you pick which chapters to include (all / none / invert).
- Downloads each chapter, cleans the markup into well-formed XHTML, and
  localizes chapter images into the EPUB.
- Builds a valid EPUB 3: `mimetype` (stored, first), `container.xml`,
  `content.opf` (manifest + spine + cover + nav), `toc.ncx`, `nav.xhtml`,
  a stylesheet, and one file per chapter with a correct table of contents.
- Politeness delays and retries so a whole novel can be fetched without
  hammering the site.

## Installing (unpacked extension)

1. Open `chrome://extensions/`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and pick the `extension/` folder.
4. Open a story page on a supported site (e.g. an `https://roliascan.com/manga/…/`
   page, or even a chapter page — the plugin will find the story page itself).
5. Click the NovelEpub toolbar button. The extension **opens in a new tab** and
   starts on the story you were viewing. Since it runs in its own tab the
   download keeps going while you browse other tabs — just don't close the
   NovelEpub tab until it finishes.
6. Click **Fetch Chapters**, prune the list if you want, and click
   **Create EPUB**.

You can also open the page directly and paste a story (or chapter) URL into the
box at the top.

## Running the offline test suite

    cd extension
    npm install
    npm test

`npm test` runs `test/make-sample.js`, which exercises the whole pipeline
against two saved example pages (in `context/`) with a stubbed `fetch()`, and
validates the assembled EPUB (file ordering, XML well-formedness, manifest /
spine / nav / ncx consistency, href resolution, UUID format). It writes a
sample to `extension/out/sample.epub`. Requires Node 18+.

## Adding a new site

Each site is a self contained folder under `extension/sites/`. The rule is
simple: **a change to one site must not be able to affect another**, so no site
specific markup, URL or API detail may ever live in `core/`.

1. Create a folder `extension/sites/yoursite/` containing `index.js`:

   ```js
   import { YourSiteParser } from "./YourSiteParser.js";

   export const yoursite = {
     name: "YourSite",
     hostNames: ["yoursite.com"],
     create(options = {}) {
       return new YourSiteParser(options);
     },
   };
   ```

2. Create `extension/sites/yoursite/YourSiteParser.js`:

   ```js
   import { Parser } from "../../core/Parser.js";

   export class YourSiteParser extends Parser {
     constructor(options = {}) {
       super({ name: "YourSite", minimumThrottle: 300, ...options });
     }

     // strip this site's ad slots / donation boxes out of chapter content.
     // Declare them here; never add them to core/Parser.js.
     get contentSelectorsToRemove() {
       return [".ad-slot", "div.ad"];
     }

     // 1. chapter list: returns [{ sourceUrl, chapterNumber, title }]
     async getChapterList(dom) { /* ... */ }

     // 2. story content on a chapter page
     findContent(dom) { return dom.querySelector(".the-story-text"); }

     // 3. (optional) the chapter heading, e.g. the <h1> subtitle
     findChapterTitle(dom, chapter) { /* ... */ }

     // 4. (optional) metadata overrides:
     //    extractTitle / extractAuthor / extractDescription / extractCoverImageUrl
   }
   ```

   Helpers that only this site needs (token hashes, API wrappers, selectors)
   belong in the same folder — see `sites/roliascan/md5.js`, which is used only
   by the roliascan plugin.

3. Register it in `extension/sites/index.js`:

   ```js
   import { yoursite } from "./yoursite/index.js";
   const SITES = [roliascanSite, yoursite];
   ```

4. Grant the extension access in `extension/manifest.json`:

   ```json
   "host_permissions": ["https://roliascan.com/*", "https://yoursite.com/*"]
   ```

5. Add a test under `test/sites/yoursite.test.js` with fixtures under
   `test/fixtures/yoursite/`, then reload the extension
   (`chrome://extensions` → Reload).

`getChapterList(chapter sourceUrls)` can fetch anything you like (the UI
supplies a `this.httpClient` with built-in rate limiting and retries);
`findContent()` is all a chapter page needs — `Parser.buildChapterContent()`
handles cleaning, image localization, and XHTML generation.

## Project layout

    extension/
      manifest.json            MV3 manifest (host permissions = allowed sites)
      background.js            toolbar click opens pages/app.html in a new tab,
                               passing it the active tab's URL
      pages/app.{html,css,js}  the download UI (runs in its own tab so the
                               download keeps running while you switch tabs)
      core/                    shared by every site - contains NO site specific code
        Util.js                DOMParser/XML/file helpers
        HttpClient.js          fetch wrapper (delay, retries, timeout)
        Parser.js              base plugin class (metadata, cleaning, XHTML)
        ParserFactory.js       hostname -> plugin registry
        ImageCollector.js      image download + localization into OEBPS/Images/
        EpubBuilder.js         assembles the EPUB 3 zip
      sites/                   one self contained folder per site
        index.js               registry: imports each site's definition
        roliascan/
          index.js             site definition (hostNames + factory)
          RoliaScansParser.js  markup + the site's JSON chapter API
          md5.js               the site's anti-scrape token hash
      test/
        core/*.test.js         unit tests for core/ modules
        sites/*.test.js        one test file per site, with its own fixtures
        fixtures/<site>/       saved example pages for that site only
        helpers/               jsdom setup, fixture loading, fake fetch
      lib/jszip.min.js         vendored JSZip
      icons/                   extension icons
