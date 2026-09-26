/*
  Guards the modularity rule: one site must never be able to affect another.

  These tests read the source tree, so they fail the moment somebody "just
  adds a selector" to core/ or reaches into another site's folder - the exact
  coupling that made the old single shared parser file a problem.
*/

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";

const { parserFactory } = await import("../../sites/index.js");

const EXT_ROOT = new URL("../../", import.meta.url);
const SITES_DIR = new URL("sites/", EXT_ROOT);
const CORE_DIR = new URL("core/", EXT_ROOT);
const TEST_DIR = new URL("test/", EXT_ROOT);

async function listJsFiles(dirUrl) {
  const entries = await readdir(dirUrl, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".js"))
    .map((e) => new URL(e.name, dirUrl));
}

async function listSiteFolders() {
  const entries = await readdir(SITES_DIR, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

async function readText(url) {
  return await readFile(url, "utf8");
}

/** Every relative import specifier in a source file. */
function importSpecifiers(source) {
  const specifiers = [];
  const pattern = /(?:^|\n)\s*(?:import|export)[^;\n]*?from\s+["']([^"']+)["']/g;
  let match;
  while ((match = pattern.exec(source)) != null) {
    specifiers.push(match[1]);
  }
  return specifiers;
}

/**
 * Strip comments so a doc example naming a site (or a selector) does not count
 * as the core depending on it - only real code is checked.
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

describe("site plugin isolation", () => {
  test("there is at least one site plugin to check", async () => {
    const folders = await listSiteFolders();
    assert.ok(folders.length > 0, "no site folders found under sites/");
  });

  test("no site folder imports another site folder", async () => {
    const folders = await listSiteFolders();
    for (const folder of folders) {
      for (const file of await listJsFiles(new URL(`${folder}/`, SITES_DIR))) {
        const source = await readText(file);
        for (const specifier of importSpecifiers(source)) {
          const match = specifier.match(/^\.\.\/([a-z0-9-]+)\//);
          if (match == null) continue;
          assert.ok(
            !folders.includes(match[1]),
            `sites/${folder}/${file.pathname.split("/").pop()} imports another site: ${specifier}`
          );
        }
      }
    }
  });

  test("core/ never imports from sites/", async () => {
    for (const file of await listJsFiles(CORE_DIR)) {
      const source = await readText(file);
      for (const specifier of importSpecifiers(source)) {
        assert.ok(
          !specifier.includes("../sites/"),
          `core/${file.pathname.split("/").pop()} imports ${specifier}`
        );
      }
    }
  });

  test("core/ mentions no site host name", async () => {
    const hosts = parserFactory.supportedHostNames();
    assert.ok(hosts.length > 0, "no hosts registered");
    for (const file of await listJsFiles(CORE_DIR)) {
      const name = file.pathname.split("/").pop();
      const source = stripComments(await readText(file));
      for (const host of hosts) {
        assert.ok(
          !source.includes(host),
          `core/${name} mentions ${host}; site specifics must live in the site's own folder`
        );
      }
    }
  });

  test("core/ hard codes no site specific CSS class", async () => {
    // class names that only make sense for one site's markup.  Matched as a
    // selector (".reader-text") so a class smuggled into a larger selector
    // list is caught too, not just a standalone one.
    const siteClasses = ["reader-text", "adsbygoogle", "rolia-ad-slot", "novel-epub-exclude"];
    for (const file of await listJsFiles(CORE_DIR)) {
      const name = file.pathname.split("/").pop();
      const source = stripComments(await readText(file));
      for (const className of siteClasses) {
        assert.ok(
          !source.includes(`.${className}`),
          `core/${name} hard codes the site class .${className}`
        );
      }
    }
  });

  test("core/ hard codes no site specific element id", async () => {
    // ids that only exist in one site's markup
    const siteIds = ["panel-chapters", "list-chapter"];
    for (const file of await listJsFiles(CORE_DIR)) {
      const name = file.pathname.split("/").pop();
      const source = stripComments(await readText(file));
      for (const id of siteIds) {
        assert.ok(!source.includes(`#${id}`), `core/${name} hard codes the site id #${id}`);
      }
    }
  });
});

describe("site plugin self containment", () => {
  test("every site folder exports a definition registered with the factory", async () => {
    const folders = await listSiteFolders();
    for (const folder of folders) {
      const indexFile = new URL(`${folder}/index.js`, SITES_DIR);
      const source = await readText(indexFile);
      assert.match(
        source, /export const \w+Site = \{/,
        `sites/${folder}/index.js must export a site definition object`
      );
      assert.match(source, /hostNames:/, `sites/${folder}/index.js must declare hostNames`);
      assert.match(source, /create\(/, `sites/${folder}/index.js must expose create()`);
    }
  });

  test("every registered host is declared by exactly one site folder", async () => {
    const registered = parserFactory.supportedHostNames();
    const owners = new Map();
    for (const folder of await listSiteFolders()) {
      const module = await import(new URL(`${folder}/index.js`, SITES_DIR).href);
      for (const definition of Object.values(module)) {
        const hosts = definition?.hostNames;
        if (!Array.isArray(hosts)) continue;
        for (const host of hosts) {
          assert.ok(
            !owners.has(host),
            `${host} is claimed by both sites/${owners.get(host)}/ and sites/${folder}/`
          );
          owners.set(host, folder);
        }
      }
    }
    for (const host of registered) {
      assert.ok(
        owners.has(host),
        `${host} is registered but no sites/<folder>/ definition claims it`
      );
    }
    assert.equal(owners.size, registered.length, "a folder declares an unregistered host");
  });

  test("no two sites claim the same host name", () => {
    const hosts = parserFactory.supportedHostNames();
    assert.equal(new Set(hosts).size, hosts.length, `duplicate host registration: ${hosts.join(",")}`);
  });

  test("each site keeps its own fixtures", async () => {
    const fixtures = await readdir(new URL("fixtures/", TEST_DIR), { withFileTypes: true });
    const fixtureFolders = fixtures.filter((e) => e.isDirectory()).map((e) => e.name);
    for (const folder of await listSiteFolders()) {
      assert.ok(
        fixtureFolders.includes(folder),
        `sites/${folder}/ has no test/fixtures/${folder}/ directory`
      );
    }
  });

  test("each site has its own test file", async () => {
    const tests = await readdir(new URL("sites/", TEST_DIR), { withFileTypes: true });
    const testNames = tests.filter((e) => e.isFile() && e.name.endsWith(".test.js")).map((e) => e.name);
    for (const folder of await listSiteFolders()) {
      assert.ok(
        testNames.includes(`${folder}.test.js`),
        `no test/sites/${folder}.test.js for sites/${folder}/`
      );
    }
  });
});
