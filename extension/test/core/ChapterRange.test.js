import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { ChapterRange } from "../../core/ChapterRange.js";

/** A chapter list shaped like the one a site plugin returns. */
function list(...numbers) {
  return numbers.map((chapterNumber) => ({
    chapterNumber,
    sourceUrl: `https://example.com/novel/${chapterNumber}/`,
    title: `Chapter ${chapterNumber}`,
  }));
}

const numbersOf = (chapters) => chapters.map((c) => c.chapterNumber);

describe("ChapterRange.matches", () => {
  test("matches a plain number", () => {
    assert.ok(ChapterRange.matches("7", "7"));
    assert.ok(!ChapterRange.matches("7", "8"));
  });

  test("ignores surrounding space and case", () => {
    assert.ok(ChapterRange.matches(" 7 ", "7"));
    assert.ok(ChapterRange.matches("Prologue", " prologue "));
  });

  test("treats 07 and 7 as the same chapter", () => {
    assert.ok(ChapterRange.matches("7", "07"));
    assert.ok(ChapterRange.matches(7, "7"));
  });

  test("compares part numbers as numbers, not as text", () => {
    assert.ok(ChapterRange.matches("1.5", "1.5"));
    assert.ok(ChapterRange.matches("1.5", "1.50"), "1.50 is the same number as 1.5");
    assert.ok(!ChapterRange.matches("1.5", "1.6"));
  });

  test("never matches on an empty bound", () => {
    assert.ok(!ChapterRange.matches("7", ""));
    assert.ok(!ChapterRange.matches("7", "   "));
    assert.ok(!ChapterRange.matches("7", null));
  });

  test("never matches a chapter with no number", () => {
    assert.ok(!ChapterRange.matches("", "7"));
    assert.ok(!ChapterRange.matches(undefined, "7"));
  });

  test("does not treat non-numbers as numbers", () => {
    assert.ok(ChapterRange.matches("Extra 1", "extra 1"));
    assert.ok(!ChapterRange.matches("Extra 1", "Extra 2"));
  });
});

describe("ChapterRange.resolve", () => {
  const chapters = list("1", "2", "3", "4", "5");

  test("selects an inclusive numeric range", () => {
    const result = ChapterRange.resolve(chapters, "2", "4");
    assert.deepEqual(numbersOf(result.chapters), ["2", "3", "4"]);
    assert.equal(result.error, null);
    assert.equal(result.swapped, false);
  });

  test("a single chapter is a valid range", () => {
    const result = ChapterRange.resolve(chapters, "3", "3");
    assert.deepEqual(numbersOf(result.chapters), ["3"]);
  });

  test("a blank from means the start of the list", () => {
    const result = ChapterRange.resolve(chapters, "", "2");
    assert.deepEqual(numbersOf(result.chapters), ["1", "2"]);
  });

  test("a blank to means the end of the list", () => {
    const result = ChapterRange.resolve(chapters, "4", "");
    assert.deepEqual(numbersOf(result.chapters), ["4", "5"]);
  });

  test("both blank selects everything", () => {
    const result = ChapterRange.resolve(chapters, "", "");
    assert.equal(result.chapters.length, 5);
  });

  test("tolerates whitespace in the bounds", () => {
    const result = ChapterRange.resolve(chapters, " 2 ", " 4 ");
    assert.deepEqual(numbersOf(result.chapters), ["2", "3", "4"]);
  });

  test("a reversed range is swapped and reported, not left empty", () => {
    const result = ChapterRange.resolve(chapters, "4", "2");
    assert.deepEqual(numbersOf(result.chapters), ["2", "3", "4"]);
    assert.equal(result.swapped, true);
    assert.match(result.warnings.join(" "), /Reversed/);
  });

  test("an unknown from is an error, and selects nothing", () => {
    const result = ChapterRange.resolve(chapters, "99", "");
    assert.equal(result.error, "No chapter numbered 99 in this story.");
    assert.equal(result.invalidField, "from", "the page needs to know which box to mark");
    assert.deepEqual(result.chapters, []);
  });

  test("an unknown to is an error, and selects nothing", () => {
    const result = ChapterRange.resolve(chapters, "", "banana");
    assert.equal(result.error, "No chapter numbered banana in this story.");
    assert.equal(result.invalidField, "to");
    assert.deepEqual(result.chapters, []);
  });

  test("a good range blames neither box", () => {
    const result = ChapterRange.resolve(chapters, "2", "4");
    assert.equal(result.invalidField, null);
  });

  test("keeps every chapter sharing a duplicated number", () => {
    const duplicated = list("1", "5", "6", "5", "7");
    const result = ChapterRange.resolve(duplicated, "5", "5");
    assert.deepEqual(numbersOf(result.chapters), ["5", "6", "5"]);
  });

  test("handles part numbers", () => {
    const parts = list("1", "1.5", "2", "2.5", "3");
    const result = ChapterRange.resolve(parts, "1.5", "2.5");
    assert.deepEqual(numbersOf(result.chapters), ["1.5", "2", "2.5"]);
  });

  test("handles non-numeric numbers such as prologues", () => {
    const mixed = list("Prologue", "1", "2", "Epilogue");
    const result = ChapterRange.resolve(mixed, "Prologue", "2");
    assert.deepEqual(numbersOf(result.chapters), ["Prologue", "1", "2"]);
  });

  test("selects from the first 'to' match through the last", () => {
    const repeated = list("1", "2", "3", "2", "4");
    const result = ChapterRange.resolve(repeated, "1", "2");
    assert.deepEqual(numbersOf(result.chapters), ["1", "2", "3", "2"]);
  });

  test("an empty list is not an error", () => {
    const result = ChapterRange.resolve([], "1", "2");
    assert.deepEqual(result.chapters, []);
    assert.equal(result.error, null);
  });

  test("a missing list is treated as empty", () => {
    assert.deepEqual(ChapterRange.resolve(null, "1", "2").chapters, []);
  });

  test("reports the start and end index it used", () => {
    const result = ChapterRange.resolve(chapters, "2", "4");
    assert.equal(result.start, 1);
    assert.equal(result.end, 3);
  });

  test("takes a 'to' past the last chapter as the end of the story", () => {
    // the reader types 1-1000 for a story that stops at 8; that is a request
    // for the rest of the book, not a typo worth refusing
    const result = ChapterRange.resolve(chapters, "1", "1000");
    assert.equal(result.error, null);
    assert.deepEqual(numbersOf(result.chapters), ["1", "2", "3", "4", "5"]);
    assert.match(result.warnings.join(" "), /no chapter 1000/i);
    assert.match(result.warnings.join(" "), /chapter 5/);
  });

  test("a blank 'to' still means the whole story", () => {
    const result = ChapterRange.resolve(chapters, "2", "");
    assert.deepEqual(numbersOf(result.chapters), ["2", "3", "4", "5"]);
    assert.deepEqual(result.warnings, []);
  });

  test("one past the last chapter is still the end, without a warning", () => {
    const result = ChapterRange.resolve(chapters, "", "5");
    assert.equal(result.error, null);
    assert.deepEqual(result.warnings, []);
  });

  test("a 'to' that is not a number is still reported", () => {
    const result = ChapterRange.resolve(chapters, "1", "everything");
    assert.match(result.error, /No chapter numbered everything/);
    assert.equal(result.invalidField, "to");
  });

  test("a 'to' inside the story that matches nothing is still reported", () => {
    // a bound inside the story's span that matches nothing must not be treated
    // as "past the end", which would hand back chapters nobody asked for
    const longer = list("1", "2", "88", "89", "90");
    const result = ChapterRange.resolve(longer, "1", "88o");
    assert.match(result.error, /No chapter numbered 88o/);
    assert.equal(result.invalidField, "to");
  });

  test("does not clamp a 'to' that is below the first chapter", () => {
    const result = ChapterRange.resolve(chapters, "1", "0");
    assert.match(result.error, /No chapter numbered 0/);
    assert.equal(result.invalidField, "to");
  });

  test("a 'from' past the end is reported rather than clamped", () => {
    const result = ChapterRange.resolve(chapters, "1000", "");
    assert.match(result.error, /No chapter numbered 1000/);
    assert.equal(result.invalidField, "from");
  });

  test("clamps against a story whose last chapter is not a number", () => {
    const mixed = list("1", "2", "Epilogue");
    assert.equal(ChapterRange.beyondLastChapter(mixed, "1000"), null);
    assert.equal(ChapterRange.beyondLastChapter(chapters, "1000"), chapters.length - 1);
  });

  test("a reversed range is still swapped after clamping", () => {
    const result = ChapterRange.resolve(chapters, "1000", "1");
    // "from 1000" is past the end, so it is the error case, not a swap
    assert.equal(result.invalidField, "from");
  });
});

describe("ChapterRange.numbers", () => {
  test("lists distinct numbers in list order", () => {
    assert.deepEqual(ChapterRange.numbers(list("1", "2", "1", "3")), ["1", "2", "3"]);
  });

  test("skips chapters with no number", () => {
    assert.deepEqual(ChapterRange.numbers(list("1", "", "2")), ["1", "2"]);
  });

  test("handles a missing list", () => {
    assert.deepEqual(ChapterRange.numbers(null), []);
  });
});

describe("ChapterRange.fullRange", () => {
  test("is the first and last chapter of the list", () => {
    assert.deepEqual(ChapterRange.fullRange(list("1", "2", "3")), { from: "1", to: "3" });
  });

  test("is empty for an empty list", () => {
    assert.deepEqual(ChapterRange.fullRange([]), { from: "", to: "" });
  });

  test("every number it offers is selectable", () => {
    const chapters = list("1", "1.5", "2", "Prologue", "Epilogue");
    for (const value of ChapterRange.numbers(chapters)) {
      const result = ChapterRange.resolve(chapters, value, value);
      assert.equal(result.error, null, `${value} is offered but cannot be selected`);
      assert.ok(result.chapters.length > 0, `${value} selected nothing`);
    }
  });
});
