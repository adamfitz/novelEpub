/*
  Site definition for roliascan.com.

  Everything that knows about this one site lives in this folder:
  RoliaScansParser.js (markup + API) and md5.js (the anti-scrape token hash).
  The core/ directory contains no roliascan specific code, so editing this
  plugin cannot change the output of any other site.
*/

"use strict";

import { RoliaScansParser } from "./RoliaScansParser.js";

export const roliascanSite = {
  /** Display name, used in error messages. */
  name: "RoliaScans",
  /** Host names served by this plugin (matched without a leading "www."). */
  hostNames: ["roliascan.com"],
  /** Factory used by ParserFactory to build an instance per download. */
  create(options = {}) {
    return new RoliaScansParser(options);
  },
};
