/*
  Downloads the images referenced by a chapter's content and rewrites the
  <img src> values to point at files that will live inside the EPUB
  (OEBPS/Images/).  Images that can't be downloaded are left untouched so the
  EPUB stays valid and readable.
*/

"use strict";

import { Util } from "./Util.js";

export class ImageCollector {
  constructor(httpClient) {
    this.httpClient = httpClient;
    this.reset();
  }

  reset() {
    /** @type {Array<{id: string, href: string, blob: Blob, mediaType: string}>} */
    this.images = [];
    this.imageIndex = 0;
  }

  /**
   * Scan contentElement for <img> tags, download any remote images and
   * rewrite src to a local relative path (../Images/{name}.
   *
   * @param {HTMLElement} contentElement cloned chapter content (in a DOM)
   * @param {string} baseUrl the chapter page URL used to resolve relative src
   * @param {(done: number, total: number) => void} [onProgress]
   */
  async collectImagesInDocument(contentElement, baseUrl, onProgress) {
    const images = contentElement.querySelectorAll("img[src]");
    for (let img of images) {
      const rawSrc = img.getAttribute("src");
      if (rawSrc == null || rawSrc === "") continue;
      const absoluteSrc = resolveImageUrl(rawSrc, baseUrl);
      if (absoluteSrc == null) continue; // leave data: URIs as they are
      try {
        const { blob, mediaType } = await this.downloadImage(absoluteSrc);
        const name = this.localImageName(mediaType);
        // chapter files live in OEBPS/Text/, images in OEBPS/Images/, so the
        // src inside a chapter must climb one directory level
        img.setAttribute("src", `../Images/${name}`);
        this.images.push({
          id: `img${this.images.length + 1}`,
          path: `OEBPS/Images/${name}`,
          blob,
          mediaType,
          sourceUrl: absoluteSrc,
        });
      } catch (err) {
        // keep the original src; a chapter with an unreachable image should
        // not bring the whole download to a halt.
        console.warn(`Failed to download image ${absoluteSrc}`, err);
      }
      onProgress?.(this.images.length, images.length);
    }
  }

  async downloadImage(url) {
    if (url.startsWith("data:")) {
      const blob = dataUriToBlob(url);
      return { blob, mediaType: url.split(";")[0].split(":")[1] || "image/png" };
    }
    const response = await this.httpClient.fetch(url, {
      credentials: "include",
      headers: { "Accept": "image/*" },
    });
    const blob = await response.blob();
    let mediaType = blob.type || guessMediaType(url);
    if (mediaType === "" || mediaType.startsWith("text/") || mediaType.includes("html")) {
      mediaType = guessMediaType(url);
    }
    return { blob, mediaType };
  }

  localImageName(mediaType) {
    const ext = extensionFromMediaType(mediaType) || "jpg";
    return `img${Util.zeroPad(++this.imageIndex)}.${ext}`;
  }

  hasImages() {
    return this.images.length > 0;
  }
}

function resolveImageUrl(src, baseUrl) {
  if (/^data:/i.test(src)) return null; // keep inline
  if (/^(blob:|chrome-extension:)/i.test(src)) return null;
  return Util.absoluteUrl(baseUrl, src);
}

function extensionFromMediaType(mediaType) {
  const table = {
    "image/png": "png",
    "image/gif": "gif",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/svg+xml": "svg",
    "image/avif": "avif",
    "image/bmp": "bmp",
    "image/x-icon": "ico",
  };
  return table[mediaType] ?? null;
}

function guessMediaType(url) {
  const cleaned = url.split(/[?#]/)[0].toLowerCase();
  if (/\.png$/.test(cleaned)) return "image/png";
  if (/\.gif$/.test(cleaned)) return "image/gif";
  if (/\.webp$/.test(cleaned)) return "image/webp";
  if (/\.svg$/.test(cleaned)) return "image/svg+xml";
  if (/\.avif$/.test(cleaned)) return "image/avif";
  return "image/jpeg";
}

function dataUriToBlob(dataUri) {
  const [header, b64] = dataUri.split(",");
  const mediaType = header.match(/data:([^;]+)/)?.[1] ?? "image/png";
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; ++i) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mediaType });
}