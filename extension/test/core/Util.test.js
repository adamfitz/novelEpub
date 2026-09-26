import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { installDom, isWellFormedXml, xmlParseError } from "../helpers/dom.js";

before(() => { installDom({ url: "https://example.com/novel/chapter-1/" }); });

const { Util, escapeXml, stylesheetFileName } = await import("../../core/Util.js");

function parse(html) {
  return Util.parseHtml(html);
}

describe("Util.parseHtml", () => {
  test("builds a document from a fragment", () => {
    const dom = parse("<div id='x'><p>hello</p></div>");
    assert.equal(dom.querySelector("#x p").textContent, "hello");
  });

  test("returns null instead of throwing when the parser blows up", () => {
    const real = globalThis.DOMParser;
    const realError = console.error;
    globalThis.DOMParser = class {
      parseFromString() { throw new Error("boom"); }
    };
    console.error = () => {};
    try {
      assert.equal(Util.parseHtml("<p>x</p>"), null);
    } finally {
      console.error = realError;
      globalThis.DOMParser = real;
    }
  });

  test("tolerates junk input without throwing", () => {
    assert.doesNotThrow(() => Util.parseHtml(undefined));
  });
});

describe("Util url helpers", () => {
  test("extractHostName drops the port", () => {
    assert.equal(Util.extractHostName("https://example.com:8443/a"), "example.com");
  });

  test("extractHostName returns empty string for garbage", () => {
    assert.equal(Util.extractHostName("not a url"), "");
  });

  test("stripLeadingWww removes only a leading www.", () => {
    assert.equal(Util.stripLeadingWww("www.example.com"), "example.com");
    assert.equal(Util.stripLeadingWww("example.com"), "example.com");
    assert.equal(Util.stripLeadingWww("wwwx.example.com"), "wwwx.example.com");
  });

  test("isUrl accepts http(s) only", () => {
    assert.equal(Util.isUrl("https://example.com/x"), true);
    assert.equal(Util.isUrl("http://example.com"), true);
    assert.equal(Util.isUrl("javascript:alert(1)"), false);
    assert.equal(Util.isUrl("data:image/png;base64,AAA"), false);
    assert.equal(Util.isUrl("/relative"), false);
  });

  test("absoluteUrl resolves relative paths against a base", () => {
    const base = "https://example.com/novel/chapter-1/";
    assert.equal(Util.absoluteUrl(base, "../img/a.png"), "https://example.com/novel/img/a.png");
    assert.equal(Util.absoluteUrl(base, "/img/a.png"), "https://example.com/img/a.png");
  });

  test("absoluteUrl returns the input when it cannot be resolved", () => {
    assert.equal(Util.absoluteUrl("not-a-base", "a.png"), "a.png");
  });
});

describe("Util element helpers", () => {
  test("isElementWhiteSpace treats images and breaks as content", () => {
    const dom = parse("<div id='a'>   </div><div id='b'><img src='x.png'/></div><div id='c'>t</div>");
    assert.equal(Util.isElementWhiteSpace(dom.querySelector("#a")), true);
    assert.equal(Util.isElementWhiteSpace(dom.querySelector("#b")), false);
    assert.equal(Util.isElementWhiteSpace(dom.querySelector("#c")), false);
    assert.equal(Util.isElementWhiteSpace(null), true);
  });

  test("removeElements detaches every given node", () => {
    const dom = parse("<div><p class='x'>1</p><p class='x'>2</p><p>3</p></div>");
    const root = dom.querySelector("div");
    Util.removeElements(root.querySelectorAll(".x"));
    assert.equal(root.querySelectorAll("p").length, 1);
  });

  test("removeComments strips comments but keeps text", () => {
    const dom = parse("<div id='c'>a<!-- note -->b</div>");
    const node = dom.querySelector("#c");
    Util.removeComments(node);
    assert.equal(node.innerHTML, "ab");
  });

  test("removeScriptableElements drops script, style, link, meta, iframe", () => {
    const dom = parse(
      "<div id='c'><script>x</script><style>y</style><link/><meta/><iframe></iframe><p>keep</p></div>"
    );
    const node = dom.querySelector("#c");
    Util.removeScriptableElements(node);
    assert.equal(node.querySelector("script, style, link, meta, iframe"), null);
    assert.equal(node.querySelector("p").textContent, "keep");
  });
});

describe("Util.toWellFormedXhtmlFragment", () => {
  test("self closes void elements so the result is valid XML", () => {
    const dom = parse("<div><p>a<br>b</p><hr><img src='x.png' alt='x'></div>");
    const fragment = Util.toWellFormedXhtmlFragment(dom.querySelector("div"));
    assert.equal(fragment, "<p>a<br/>b</p><hr/><img src=\"x.png\" alt=\"x\"/>");
  });

  test("does not double close an already self closed tag", () => {
    const dom = parse("<div><img src='x.png'/></div>");
    const fragment = Util.toWellFormedXhtmlFragment(dom.querySelector("div"));
    assert.equal(fragment, "<img src=\"x.png\"/>");
  });

  test("returns empty string for a missing element", () => {
    assert.equal(Util.toWellFormedXhtmlFragment(null), "");
  });

  test("output parses as XML", () => {
    const dom = parse("<div><p>a<br>b</p><img src='x.png'></div>");
    const fragment = Util.toWellFormedXhtmlFragment(dom.querySelector("div"));
    const doc = `<?xml version="1.0"?><root>${fragment}</root>`;
    assert.ok(isWellFormedXml(doc), xmlParseError(doc));
  });

  test("rewrites the HTML-only &nbsp; entity as a numeric reference", () => {
    // innerHTML serializes U+00A0 as &nbsp;, which HTML defines and XML does
    // not, so leaving it would make the chapter unparseable as XHTML
    const dom = parse("<div><p>a\u00a0b</p></div>");
    const fragment = Util.toWellFormedXhtmlFragment(dom.querySelector("div"));
    assert.ok(!/&nbsp;/.test(fragment), "left an entity XML cannot resolve");
    assert.match(fragment, /&#160;/);
    const doc = `<?xml version="1.0"?><root>${fragment}</root>`;
    assert.ok(isWellFormedXml(doc), xmlParseError(doc));
  });

  test("rewrites &nbsp; inside an attribute value too", () => {
    const dom = parse("<div><p title='a\u00a0b'>x</p></div>");
    const fragment = Util.toWellFormedXhtmlFragment(dom.querySelector("div"));
    assert.ok(!/&nbsp;/.test(fragment));
    const doc = `<?xml version="1.0"?><root>${fragment}</root>`;
    assert.ok(isWellFormedXml(doc), xmlParseError(doc));
  });

  test("leaves the other XML entities alone", () => {
    const dom = parse("<div><p>a &amp; b &lt; c</p></div>");
    const fragment = Util.toWellFormedXhtmlFragment(dom.querySelector("div"));
    assert.match(fragment, /&amp;/);
    assert.match(fragment, /&lt;/);
  });
});

describe("Util.makeChapterXhtml", () => {
  test("builds a well formed chapter document with heading and content", () => {
    const xhtml = Util.makeChapterXhtml("Chapter 1 - Start", "<p>Hello</p>", "en", 0);
    assert.ok(xhtml.startsWith('<?xml version="1.0" encoding="utf-8"?>'));
    assert.ok(xhtml.includes("<h1>Chapter 1 - Start</h1>"));
    assert.ok(xhtml.includes('<div class="novel-epub-content" id="chapter0">'));
    assert.ok(xhtml.includes("<p>Hello</p>"));
    assert.ok(xhtml.includes('href="../styles/stylesheet.css"'));
  });

  test("escapes the title so markup in it cannot break the document", () => {
    const xhtml = Util.makeChapterXhtml('A & B <script>', "<p>x</p>", "en", 0);
    assert.ok(xhtml.includes("<h1>A &amp; B &lt;script&gt;</h1>"));
    assert.ok(isWellFormedXml(xhtml), xmlParseError(xhtml));
  });
});

describe("escapeXml", () => {
  test("escapes the five XML entities", () => {
    assert.equal(escapeXml(`&<>"'`), "&amp;&lt;&gt;&quot;&apos;");
  });
});

describe("file name and path helpers", () => {
  test("safeForFileName replaces path and control characters", () => {
    assert.equal(Util.safeForFileName('a/b\\c:d*e?f"g<h>i|j'), "a_b_c_d_e_f_g_h_i_j");
  });

  test("safeForFileName truncates to the requested length", () => {
    assert.equal(Util.safeForFileName("abcdefghij", 4), "abcd");
  });

  test("zeroPad keeps lexical order matching numeric order", () => {
    assert.equal(Util.zeroPad(1), "000000001");
    assert.equal(Util.zeroPad(1000000000), "1000000000");
    assert.ok(Util.zeroPad(2) < Util.zeroPad(10));
  });

  test("makeRelativeToOebps strips the OEBPS prefix", () => {
    assert.equal(Util.makeRelativeToOebps("OEBPS/Text/a.xhtml"), "Text/a.xhtml");
    assert.equal(Util.makeRelativeToOebps("Text/a.xhtml"), "Text/a.xhtml");
  });

  test("stylesheetFileName lives under OEBPS", () => {
    assert.equal(stylesheetFileName(), "OEBPS/styles/stylesheet.css");
  });
});

describe("Util.extractDomTitle", () => {
  test("prefers og:title over the document title", () => {
    const dom = parse(
      "<head><title>Doc</title><meta property='og:title' content='Story'/></head>"
    );
    assert.equal(Util.extractDomTitle(dom), "Story");
  });

  test("falls back to the document title", () => {
    assert.equal(Util.extractDomTitle(parse("<head><title>Doc</title></head>")), "Doc");
  });
});
