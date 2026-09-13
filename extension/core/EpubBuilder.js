/*
  Builds a valid EPUB 3 file from the chapters and metadata collected from a
  site.  Follows the same structure as the WebToEpub project:

      mimetype                          (must be first, uncompressed)
      META-INF/container.xml
      OEBPS/content.opf                 (metadata, manifest, spine, guide)
      OEBPS/toc.ncx                     (NCX table of contents)
      OEBPS/nav.xhtml                   (EPUB 3 navigation document)
      OEBPS/styles/stylesheet.css
      OEBPS/Text/Cover.xhtml            (if cover image provided)
      OEBPS/Text/chapter0001.xhtml ...  (one file per chapter, reading order)
      OEBPS/Images/*                    (cover + inline images)

  Uses JSZip (loaded as a classic script that defines the global JSZip) but is
  careful to depend only on standard Blob/ArrayBuffer operations so it can also
  be exercised from node.
*/

"use strict";

import { Util, escapeXml, stylesheetFileName } from "./Util.js";

const CONTAINER_XML =
  `<?xml version="1.0" encoding="utf-8"?>\n` +
  `<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n` +
  `  <rootfiles>\n` +
  `    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>\n` +
  `  </rootfiles>\n` +
  `</container>\n`;

const DEFAULT_STYLESHEET =
  `body {\n` +
  `  font-family: serif;\n` +
  `  line-height: 1.5;\n` +
  `  margin: 1em 0.8em;\n` +
  `}\n` +
  `h1 {\n` +
  `  font-size: 1.35em;\n` +
  `  margin: 0.6em 0 0.7em 0;\n` +
  `}\n` +
  `p {\n` +
  `  margin: 0 0 0.55em 0;\n` +
  `}\n` +
  `img {\n` +
  `  max-width: 100%;\n` +
  `}\n`;

export class EpubBuilder {
  /**
   * @param {object} metaInfo extracted story metadata
   * @param {Array<{path: string, label: string, xhtml: string, sourceUrl: string}>} chapters
   * @param {Array<{path: string, blob: Blob, mediaType: string}>} images inline chapter images
   * @param {{blob: Blob, mediaType: string, sourceUrl: string}|null} cover
   */
  constructor(metaInfo, chapters, images = [], cover = null) {
    this.metaInfo = metaInfo;
    this.chapters = chapters;
    this.images = images;
    this.cover = cover;
  }

  async assemble() {
    const zip = new JSZip();
    this.addContainerFiles(zip);
    zip.file("OEBPS/content.opf", this.buildContentOpf());
    zip.file("OEBPS/toc.ncx", this.buildNcx());
    zip.file("OEBPS/nav.xhtml", this.buildNavDocument());
    zip.file(makeOebpsPath(stylesheetFileName()), DEFAULT_STYLESHEET);
    this.packChapterFiles(zip);
    this.packImageFiles(zip);
    if (this.cover != null) {
      this.packCoverFile(zip);
    }
    return zip.generateAsync({
      type: "blob",
      mimeType: "application/epub+zip",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    });
  }

  // -------------------------------------------------------------------------
  // required container files
  // -------------------------------------------------------------------------

  addContainerFiles(zip) {
    // epub spec: mimetype must be the first file in the archive and must be
    // stored uncompressed.
    zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
    zip.file("META-INF/container.xml", CONTAINER_XML);
  }

  // -------------------------------------------------------------------------
  // OEBPS/content.opf
  // -------------------------------------------------------------------------

  buildContentOpf() {
    const m = this.metaInfo;
    const parts = [];
    parts.push(`<?xml version="1.0" encoding="utf-8"?>\n`);
    parts.push(
      `<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="BookId">\n`
    );
    parts.push(this.buildOpfMetadata(m));
    parts.push(this.buildOpfManifest(m));
    parts.push(this.buildOpfSpine());
    if (this.cover != null) {
      parts.push(this.buildOpfGuide());
    }
    parts.push(`</package>\n`);
    return parts.join("");
  }

  buildOpfMetadata(m) {
    const lines = [];
    lines.push(`  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">\n`);
    lines.push(`    <dc:identifier id="BookId">urn:uuid:${this.uuid()}</dc:identifier>\n`);
    lines.push(`    <meta property="dcterms:modified">${escapeXml(this.dctermsModified())}</meta>\n`);
    lines.push(`    <dc:title>${escapeXml(m.title || "Untitled")}</dc:title>\n`);
    lines.push(`    <dc:language>${escapeXml(m.language || "en")}</dc:language>\n`);
    const author = m.author || "Unknown";
    lines.push(`    <dc:creator id="creator">${escapeXml(author)}</dc:creator>\n`);
    const authorAs = Util.safeForFileName(author, 40);
    lines.push(`    <meta refines="#creator" property="file-as">${escapeXml(authorAs)}</meta>\n`);
    lines.push(`    <meta refines="#creator" property="role" scheme="marc:relators">aut</meta>\n`);
    if (m.datePublished) {
      lines.push(`    <dc:date>${escapeXml(toOpfDate(m.datePublished))}</dc:date>\n`);
    }
    if (m.publisher) {
      lines.push(`    <dc:publisher>${escapeXml(m.publisher)}</dc:publisher>\n`);
    }
    if (m.description) {
      lines.push(`    <dc:description>${escapeXml(m.description)}</dc:description>\n`);
    }
    if (Util.isUrl(m.tocUrl)) {
      lines.push(`    <dc:source>${escapeXml(m.tocUrl)}</dc:source>\n`);
    }
    if (this.cover != null) {
      lines.push(`    <meta name="cover" content="cover-image"/>\n`);
    }
    lines.push(`  </metadata>\n`);
    return lines.join("");
  }

  buildOpfManifest(m) {
    const lines = [];
    lines.push(`  <manifest>\n`);
    lines.push(`    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>\n`);
    lines.push(`    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>\n`);
    lines.push(`    <item id="stylesheet" href="styles/stylesheet.css" media-type="text/css"/>\n`);
    if (this.cover != null) {
      const ext = mediaTypeExtension(this.cover.mediaType);
      this.coverPath = `Images/cover.${ext}`;
      lines.push(`    <item id="cover" href="Text/Cover.xhtml" media-type="application/xhtml+xml"/>\n`);
      lines.push(`    <item id="cover-image" href="${this.coverPath}" media-type="${escapeXml(this.cover.mediaType)}" properties="cover-image"/>\n`);
    }
    for (let chapter of this.chapters) {
      const href = chapter.path.replace(/^Text\//, "");
      const id = href.replace(/\.xhtml$/, "");
      lines.push(`    <item id="${id}" href="Text/${href}" media-type="application/xhtml+xml"/>\n`);
    }
    for (let image of this.images) {
      const href = image.path.replace(/^OEBPS\/Images\//, "");
      const id = `img-${href.replace(/\W+/g, "-")}`;
      lines.push(`    <item id="${id}" href="Images/${href}" media-type="${escapeXml(image.mediaType)}"/>\n`);
    }
    lines.push(`  </manifest>\n`);
    return lines.join("");
  }

  buildOpfSpine() {
    const lines = [];
    lines.push(`  <spine toc="ncx">\n`);
    if (this.cover != null) {
      lines.push(`    <itemref idref="cover"/>\n`);
    }
    for (let chapter of this.chapters) {
      const href = chapter.path.replace(/^Text\//, "");
      const id = href.replace(/\.xhtml$/, "");
      lines.push(`    <itemref idref="${id}"/>\n`);
    }
    lines.push(`  </spine>\n`);
    return lines.join("");
  }

  buildOpfGuide() {
    return (
      `  <guide>\n` +
      `    <reference type="cover" title="Cover" href="Text/Cover.xhtml"/>\n` +
      `  </guide>\n`
    );
  }

  // -------------------------------------------------------------------------
  // OEBPS/toc.ncx
  // -------------------------------------------------------------------------

  buildNcx() {
    const m = this.metaInfo;
    const lines = [];
    lines.push(`<?xml version="1.0" encoding="utf-8"?>\n`);
    lines.push(`<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">\n`);
    lines.push(`  <head>\n`);
    lines.push(`    <meta name="dtb:uid" content="urn:uuid:${escapeXml(this.uuid())}"/>\n`);
    lines.push(`    <meta name="dtb:depth" content="${Math.max(2, this.chapters.length ? 2 : 2)}"/>\n`);
    lines.push(`    <meta name="dtb:totalPageCount" content="0"/>\n`);
    lines.push(`    <meta name="dtb:maxPageNumber" content="0"/>\n`);
    lines.push(`  </head>\n`);
    lines.push(`  <docTitle><text>${escapeXml(m.title || "Untitled")}</text></docTitle>\n`);
    lines.push(`  <navMap>\n`);
    let playOrder = 0;
    for (let chapter of this.chapters) {
      ++playOrder;
      lines.push(
        `    <navPoint id="np${playOrder}" playOrder="${playOrder}">\n` +
        `      <navLabel><text>${escapeXml(chapter.label)}</text></navLabel>\n` +
        `      <content src="Text/${chapter.path.replace(/^Text\//, "")}"/>\n` +
        `    </navPoint>\n`
      );
    }
    lines.push(`  </navMap>\n`);
    lines.push(`</ncx>\n`);
    return lines.join("");
  }

  // -------------------------------------------------------------------------
  // OEBPS/nav.xhtml - EPUB 3 navigation document
  // -------------------------------------------------------------------------

  buildNavDocument() {
    const m = this.metaInfo;
    const lines = [];
    lines.push(`<?xml version="1.0" encoding="utf-8"?>\n`);
    lines.push(`<!DOCTYPE html>\n`);
    lines.push(
      `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${escapeXml(m.language || "en")}" lang="${escapeXml(m.language || "en")}">\n`
    );
    lines.push(`  <head>\n`);
    lines.push(`    <title>Table of Contents</title>\n`);
    lines.push(`    <link rel="stylesheet" type="text/css" href="styles/stylesheet.css"/>\n`);
    lines.push(`  </head>\n`);
    lines.push(`  <body>\n`);
    lines.push(`    <nav epub:type="toc" id="toc">\n`);
    lines.push(`      <h1>Table of Contents</h1>\n`);
    lines.push(`      <ol>\n`);
    for (let chapter of this.chapters) {
      lines.push(
        `        <li><a href="Text/${chapter.path.replace(/^Text\//, "")}">${escapeXml(chapter.label)}</a></li>\n`
      );
    }
    lines.push(`      </ol>\n`);
    lines.push(`    </nav>\n`);
    lines.push(`  </body>\n`);
    lines.push(`</html>\n`);
    return lines.join("");
  }

  // -------------------------------------------------------------------------
  // content files
  // -------------------------------------------------------------------------

  packChapterFiles(zip) {
    for (let chapter of this.chapters) {
      zip.file(`OEBPS/Text/${chapter.path.replace(/^Text\//, "")}`, chapter.xhtml);
    }
  }

  packImageFiles(zip) {
    for (let image of this.images) {
      zip.file(image.path, image.blob);
    }
  }

  packCoverFile(zip) {
    zip.file(`OEBPS/${this.coverPath}`, this.cover.blob);
    const coverXhtml =
      `<?xml version="1.0" encoding="utf-8"?>\n` +
      `<!DOCTYPE html>\n` +
      `<html xmlns="http://www.w3.org/1999/xhtml">\n` +
      `  <head>\n` +
      `    <title>Cover</title>\n` +
      `    <link rel="stylesheet" type="text/css" href="styles/stylesheet.css"/>\n` +
      `  </head>\n` +
      `  <body>\n` +
      `    <div style="text-align:center;">\n` +
      `      <img src="../${this.coverPath}" alt="Cover"/>\n` +
      `    </div>\n` +
      `  </body>\n` +
      `</html>\n`;
    zip.file("OEBPS/Text/Cover.xhtml", coverXhtml);
  }

  uuid() {
    if (this._uuid == null) {
      this._uuid = deterministicUuid(
        `${this.metaInfo.tocUrl}|${this.metaInfo.title}`
      );
    }
    return this._uuid;
  }

  dctermsModified() {
    return new Date().toISOString();
  }
}

function mediaTypeExtension(mediaType) {
  const table = {
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/svg+xml": "svg",
    "image/avif": "avif",
    "image/bmp": "bmp",
  };
  return table[mediaType] ?? "jpg";
}

function toOpfDate(value) {
  // normalize to YYYY-MM-DDTHH:MM:SSZ or the exact date if only year given
  const date = new Date(value);
  if (!isNaN(date.getTime())) {
    return date.toISOString();
  }
  return value;
}

function makeOebpsPath(href) {
  return href.replace(/^\.\.\//, "OEBPS/");
}

function deterministicUuid(seed) {
  // small FNV-1a hash -> stable 128 bit value formatted as a UUID
  let h1 = 2166136261;
  let h2 = 2166136261;
  for (let i = 0; i < seed.length; ++i) {
    const code = seed.charCodeAt(i);
    h1 ^= code;
    h1 = Math.imul(h1, 16777619) >>> 0;
    h2 ^= code ^ i;
    h2 = Math.imul(h2, 16777619) >>> 0;
  }
  h1 = h1 >>> 0;
  h2 = h2 >>> 0;
  const x = Math.imul(h1, 0x45d9f3b) >>> 0;
  const y = Math.imul(h2, 0x663f04bb) >>> 0;
  const hex32 = (value) => value.toString(16).padStart(8, "0");
  const body =
    hex32(h1) +
    hex32(h2) +
    hex32(x) +
    hex32(y);
  return (
    body.substring(0, 8) + "-" +
    body.substring(8, 12) + "-" +
    "4" + body.substring(13, 16) + "-" +
    "a" + body.substring(17, 20) + "-" +
    body.substring(20, 32)
  );
}