/*
  Site registry.

  Each site is a self contained folder under sites/ that exports a definition
  object ({ name, hostNames, create }).  Adding a site means:

    1. create sites/yoursite/index.js (plus whatever helpers that site needs,
       also inside sites/yoursite/)
    2. import its definition below and add it to the SITES array
    3. add "https://yoursite.com/*" to host_permissions in manifest.json

  Nothing else has to change, and in particular no other site's folder is
  touched - two plugins can never affect each other.
*/

"use strict";

import { parserFactory } from "../core/ParserFactory.js";
import { roliascanSite } from "./roliascan/index.js";

/** @type {Array<{name: string, hostNames: string[], create: function}>} */
const SITES = [
  roliascanSite,
];

for (const site of SITES) {
  for (const hostName of site.hostNames) {
    parserFactory.register(hostName, () => site.create());
  }
}

export { parserFactory };
