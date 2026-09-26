/*
  Fixture loading.

  Every site keeps its own saved example pages under
  test/fixtures/<siteName>/, so a site test can only ever read its own
  fixtures and adding or changing a site never touches another site's data.

  Relative URLs inside a fixture resolve against the jsdom window URL set by
  installDom(), which is what gives a parsed chapter page its real base URI.
*/

import { readFile } from "node:fs/promises";

const FIXTURES_ROOT = new URL("../fixtures/", import.meta.url);

/** Absolute file URL of a fixture: fixtureUrl("roliascan", "story.html"). */
export function fixtureUrl(site, name) {
  return new URL(`${site}/${name}`, FIXTURES_ROOT);
}

/** Read a fixture as UTF-8 text. */
export function readFixture(site, name) {
  return readFile(fixtureUrl(site, name), "utf8");
}

/** Read and parse a JSON fixture. */
export async function readFixtureJson(site, name) {
  return JSON.parse(await readFixture(site, name));
}

/** Parse an HTML string into a Document using the installed DOMParser. */
export async function parseHtml(html) {
  const { Util } = await import("../../core/Util.js");
  return Util.parseHtml(html);
}

/**
 * Read an HTML fixture and parse it into a Document.
 * @param {string} site fixture folder name
 * @param {string} name fixture file name
 */
export async function readFixtureDom(site, name) {
  return parseHtml(await readFixture(site, name));
}
