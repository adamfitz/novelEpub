/*
  Site definition for fenrirealm.com.

  Everything that knows about this one site lives in this folder:
  FenriRealmParser.js (the JSON API and content formats) and content.js (the
  ProseMirror body decoder).  The core/ directory contains no fenrirealm
  specific code, so editing this plugin cannot change the output of any other
  site.
*/

"use strict";

import { FenriRealmParser } from "./FenriRealmParser.js";

export const fenrirealmSite = {
  /** Display name, used in error messages. */
  name: "FenrirRealm",
  /** Host names served by this plugin (matched without a leading "www."). */
  hostNames: ["fenrirealm.com"],
  /** Factory used by ParserFactory to build an instance per download. */
  create(options = {}) {
    return new FenriRealmParser(options);
  },
};
