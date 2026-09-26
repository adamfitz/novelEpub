import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { installDom } from "../helpers/dom.js";

before(() => { installDom(); });

const { ParserFactory } = await import("../../core/ParserFactory.js");
const { Parser } = await import("../../core/Parser.js");

class DummyParser extends Parser {
  constructor(options = {}) {
    super({ name: "Dummy", ...options });
  }
}

describe("ParserFactory.register", () => {
  test("matches a host name and returns a fresh instance each time", () => {
    const factory = new ParserFactory();
    factory.register("example.com", () => new DummyParser());
    const first = factory.fetchByUrl("https://example.com/story/");
    const second = factory.fetchByUrl("https://example.com/story/");
    assert.ok(first instanceof DummyParser);
    assert.notEqual(first, second, "each call must build its own instance");
  });

  test("ignores a leading www. in the tab URL", () => {
    const factory = new ParserFactory();
    factory.register("example.com", () => new DummyParser());
    assert.ok(factory.fetchByUrl("https://www.example.com/story/") instanceof DummyParser);
  });

  test("ignores a leading www. in the registration", () => {
    const factory = new ParserFactory();
    factory.register("www.example.com", () => new DummyParser());
    assert.ok(factory.fetchByUrl("https://example.com/") instanceof DummyParser);
    assert.ok(factory.supportedHostNames().includes("example.com"));
  });

  test("refuses a duplicate registration so sites cannot shadow each other", () => {
    const factory = new ParserFactory();
    factory.register("example.com", () => new DummyParser());
    assert.throws(
      () => factory.register("www.example.com", () => new DummyParser()),
      /Duplicate parser/
    );
  });

  test("returns null for an unknown host", () => {
    const factory = new ParserFactory();
    factory.register("example.com", () => new DummyParser());
    assert.equal(factory.fetchByUrl("https://unknown.test/story/"), null);
  });

  test("returns null for a URL it cannot parse", () => {
    const factory = new ParserFactory();
    assert.equal(factory.fetchByUrl("nonsense"), null);
  });

  test("does not treat one host as a suffix of another", () => {
    const factory = new ParserFactory();
    factory.register("example.com", () => new DummyParser());
    assert.equal(factory.fetchByUrl("https://notexample.com/"), null);
  });
});

describe("ParserFactory.registerRule", () => {
  test("falls back to a URL predicate when no host matches", () => {
    const factory = new ParserFactory();
    factory.register("example.com", () => new DummyParser());
    let called = 0;
    factory.registerRule(
      (url) => url.includes("/manga/"),
      () => { called += 1; return new DummyParser(); }
    );
    const parser = factory.fetchByUrl("https://other.test/manga/thing/");
    assert.ok(parser instanceof DummyParser);
    assert.equal(called, 1);
  });

  test("a direct host match wins over a rule", () => {
    const factory = new ParserFactory();
    factory.register("example.com", () => new DummyParser({ name: "Direct" }));
    factory.registerRule(() => true, () => new DummyParser({ name: "Rule" }));
    assert.equal(factory.fetchByUrl("https://example.com/").name, "Direct");
  });
});

describe("ParserFactory.supportedHostNames", () => {
  test("lists every registered host", () => {
    const factory = new ParserFactory();
    factory.register("a.test", () => new DummyParser());
    factory.register("b.test", () => new DummyParser());
    assert.deepEqual(factory.supportedHostNames(), ["a.test", "b.test"]);
  });
});
