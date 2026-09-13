/*
  Registry that maps a site host name to the parser that knows how to read it.

  Usage:
    import { parserFactory } from "./ParserFactory.js";
    parserFactory.register("roliascan.com", () => new RoliaScansParser());

  fetchByUrl() returns a new parser instance for the current URL or null when
  the site is not supported (yet).
*/

"use strict";

import { Util } from "./Util.js";

class ParserFactory {
  constructor() {
    this.parsers = new Map();
    this.urlRules = [];
  }

  /**
   * Register a parser for a host name.  The host name is matched against the
   * tab URL with the leading "www." (and any port) ignored.
   * @param {string} hostName e.g. "roliascan.com"
   * @param {function} constructor returns a new Parser instance
   */
  register(hostName, constructor) {
    const key = Util.stripLeadingWww(hostName);
    if (this.parsers.has(key)) {
      throw new Error(`Duplicate parser registered for ${key}`);
    }
    this.parsers.set(key, constructor);
  }

  /**
   * Register a parser matched by an arbitrary URL predicate.
   * Useful for sites that host stories at many domains.
   * @param {function(string): boolean} test
   * @param {function} constructor
   */
  registerRule(test, constructor) {
    this.urlRules.push({ test, constructor });
  }

  /**
   * @param {string} url
   * @returns {Parser|null} a new parser instance able to handle the URL
   */
  fetchByUrl(url) {
    const hostName = Util.stripLeadingWww(Util.extractHostName(url));
    const constructor = this.parsers.get(hostName);
    if (constructor != null) {
      return constructor();
    }
    for (let rule of this.urlRules) {
      if (rule.test(url)) {
        return rule.constructor();
      }
    }
    return null;
  }

  supportedHostNames() {
    return [...this.parsers.keys()];
  }
}

export const parserFactory = new ParserFactory();