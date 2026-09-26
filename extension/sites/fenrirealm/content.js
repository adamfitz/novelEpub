/*
  Conversion of the chapter bodies fenrirealm.com serves with
  `content_format: "json"`.

  The body is a ProseMirror document: a tree of nodes that each have a `type`,
  optional `attrs` and a nested `content` array, with the actual words in
  `text` nodes.  The site renders it with a ProseMirror schema that also defines
  its own node types (spoilers, tooltips, footnotes, ...), so anything this
  file does not recognise falls through to its children - that way a node type
  added to the site later still contributes its text instead of disappearing.

  Node types the site uses purely for layout or for hiding text from the reader
  are dropped (see SKIPPED_TYPES).
*/

"use strict";

import { escapeXml } from "../../core/Util.js";

/** Types that carry no reader visible text. */
const SKIPPED_TYPES = new Set([
  "hiddenParagraph",
  "readerAttribution",
  "systemWindow",
  "ad",
  "advertisement",
]);

/** Block level containers, mapped to the XHTML element they become. */
const BLOCK_TAGS = {
  paragraph: "p",
  blockquote: "blockquote",
  heading: "h2",
  codeBlock: "pre",
  horizontalRule: "hr",
};

/** Wrappers whose children are list items. */
const LIST_TAGS = {
  bulletList: "ul",
  orderedList: "ol",
};

export function proseMirrorToHtml(node) {
  const html = renderChildren(node);
  return html;
}

function renderChildren(node) {
  const children = node?.content;
  if (!Array.isArray(children)) return "";
  return children.map(renderNode).join("");
}

function renderNode(node) {
  if (node == null || typeof node !== "object") return "";
  const type = node.type;

  if (type === "text") {
    return escapeXml(node.text ?? "");
  }
  if (type === "hardBreak") {
    return "<br/>";
  }
  if (type == null || SKIPPED_TYPES.has(type)) {
    return type == null ? renderChildren(node) : "";
  }

  if (type === "image") {
    return renderImage(node);
  }

  const listTag = LIST_TAGS[type];
  if (listTag != null) {
    return `<${listTag}>${renderChildren(node)}</${listTag}>`;
  }
  if (type === "listItem") {
    return `<li>${renderChildren(node)}</li>`;
  }

  const blockTag = BLOCK_TAGS[type];
  if (blockTag != null) {
    if (blockTag === "hr") {
      return "<hr/>";
    }
    // the site strips empty paragraphs itself; do the same so a chapter does
    // not open with a run of blank lines
    const inner = renderChildren(node);
    if (stripTags(inner).trim() === "" && !hasMedia(inner)) {
      return "";
    }
    return `<${blockTag}>${inner}</${blockTag}>`;
  }

  // unknown node type: keep the words, drop the wrapper
  return renderChildren(node);
}

function renderImage(node) {
  const src = node.attrs?.src ?? node.attrs?.HTMLAttributes?.src;
  if (typeof src !== "string" || src === "") return "";
  const alt = node.attrs?.alt ?? node.attrs?.title;
  const altAttribute = typeof alt === "string" && alt !== "" ? ` alt="${escapeXml(alt)}"` : "";
  return `<img src="${escapeXml(src)}"${altAttribute}/>`;
}

function hasMedia(html) {
  return /<img\b|<hr\b/i.test(html);
}

function stripTags(html) {
  return html.replace(/<[^>]*>/g, "");
}
