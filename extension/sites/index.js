/*
  Registers every site plugin with the parser factory.

  To add a new site:
    1. create sites/YourSiteParser.js with class YourSiteParser extends Parser
    2. import YourSiteParser below
    3. add a parserFactory.register(...) line
    4. add "https://yoursite.com/*" to host_permissions in manifest.json
*/

"use strict";

import { parserFactory } from "../core/ParserFactory.js";
import { RoliaScansParser } from "./RoliaScansParser.js";

parserFactory.register("roliascan.com", () => new RoliaScansParser());

export { parserFactory };