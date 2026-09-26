/*
  Selecting a first/last chapter range from a chapter list.

  This is the "from … to …" selection the UI offers, and it is kept here rather
  than in the page script so it can be tested on its own.  It knows nothing
  about any particular site: it only reads the `chapterNumber` of a list entry,
  whatever that site chose to put there ("7", "7.5", "Prologue", ...).

  A bound is matched the way a reader expects:
    - numbers compare numerically, so "07" and "7" are the same chapter and
      "1.5" sits between "1" and "2";
    - anything else compares as trimmed, case insensitive text.
  A bound that matches nothing is reported rather than silently ignored, since
  quietly downloading the whole story is the one outcome a user would not notice.
*/

"use strict";

export const ChapterRange = {
  /**
   * True when a chapter's number is the one the user typed.
   * @param {string|number} chapterNumber
   * @param {string} query
   */
  matches(chapterNumber, query) {
    const wanted = String(query ?? "").trim();
    if (wanted === "") return false;
    const actual = String(chapterNumber ?? "").trim();
    if (actual === "") return false;
    if (actual.toLowerCase() === wanted.toLowerCase()) return true;
    const a = Number(actual);
    const b = Number(wanted);
    if (Number.isFinite(a) && Number.isFinite(b)) return a === b;
    return false;
  },

  /**
   * Index of the first chapter matching `query`, or -1.
   */
  indexOfFirst(chapters, query) {
    for (let i = 0; i < chapters.length; ++i) {
      if (ChapterRange.matches(chapters[i].chapterNumber, query)) return i;
    }
    return -1;
  },

  /**
   * Index of the last chapter matching `query`, or -1.
   *
   * The last match rather than the first, so a bound like "5" keeps every
   * chapter numbered 5 instead of cutting a duplicate in half.
   */
  indexOfLast(chapters, query) {
    for (let i = chapters.length - 1; i >= 0; --i) {
      if (ChapterRange.matches(chapters[i].chapterNumber, query)) return i;
    }
    return -1;
  },

  /**
   * The index of the last chapter when `query` is a number past the end of the
   * list, or null.
   *
   * This is what lets a reader type "1-1000" for a story that stops at 896.
   * It only answers for a bound that really is past the end, so a typo such as
   * "1-88O", or a number that sits inside the story but matches no chapter,
   * is still reported rather than quietly swallowing the rest of the book.
   */
  beyondLastChapter(chapters, query) {
    const list = Array.isArray(chapters) ? chapters : [];
    if (list.length === 0) return null;
    const wantedText = String(query ?? "").trim();
    const lastText = String(list[list.length - 1].chapterNumber ?? "").trim();
    if (wantedText === "" || lastText === "") return null;
    const wanted = Number(wantedText);
    const last = Number(lastText);
    if (!Number.isFinite(wanted) || !Number.isFinite(last)) return null;
    return wanted > last ? list.length - 1 : null;
  },

  /**
   * Work out which chapters a "from … to …" pair selects.
   *
   * A blank bound is open ended: it means the first or the last chapter.  If the
   * two ends meet in the wrong order they are swapped, because a reversed range
   * is a typo far more often than it is a request for an empty download.
   *
   * @param {Array<{chapterNumber: string|number}>} chapters
   * @param {string} from
   * @param {string} to
   * @returns {{chapters: object[], start: number, end: number, swapped: boolean,
   *            error: string|null, invalidField: string|null, warnings: string[]}}
   */
  resolve(chapters, from, to) {
    const list = Array.isArray(chapters) ? chapters : [];
    const warnings = [];
    if (list.length === 0) {
      return empty(0);
    }

    const fromText = String(from ?? "").trim();
    const toText = String(to ?? "").trim();

    let start = 0;
    if (fromText !== "") {
      start = ChapterRange.indexOfFirst(list, fromText);
      if (start < 0) {
        return {
          ...empty(list.length),
          error: `No chapter numbered ${fromText} in this story.`,
          invalidField: "from",
        };
      }
    }

    let end = list.length - 1;
    if (toText !== "") {
      end = ChapterRange.indexOfLast(list, toText);
      if (end < 0) {
        const clamped = ChapterRange.beyondLastChapter(list, toText);
        if (clamped == null) {
          return {
            ...empty(list.length),
            error: `No chapter numbered ${toText} in this story.`,
            invalidField: "to",
          };
        }
        end = clamped;
        const last = String(list[list.length - 1].chapterNumber ?? "").trim();
        warnings.push(
          `There is no chapter ${toText}, so this was taken to the end of the ` +
          `story, chapter ${last}.`
        );
      }
    }

    let swapped = false;
    if (start > end) {
      [start, end] = [end, start];
      swapped = true;
      warnings.push("Reversed the range: showing the chapters in list order.");
    }

    return {
      chapters: list.slice(start, end + 1),
      start,
      end,
      swapped,
      error: null,
      invalidField: null,
      warnings,
    };
  },

  /**
   * Every distinct chapter number in the list, in list order, for a datalist.
   */
  numbers(chapters) {
    const seen = new Set();
    const result = [];
    for (const chapter of Array.isArray(chapters) ? chapters : []) {
      const value = String(chapter?.chapterNumber ?? "").trim();
      if (value === "" || seen.has(value)) continue;
      seen.add(value);
      result.push(value);
    }
    return result;
  },

  /** The bounds that select the whole list, used to prefill the inputs. */
  fullRange(chapters) {
    const list = Array.isArray(chapters) ? chapters : [];
    if (list.length === 0) return { from: "", to: "" };
    return {
      from: String(list[0].chapterNumber ?? "").trim(),
      to: String(list[list.length - 1].chapterNumber ?? "").trim(),
    };
  },
};

function empty(total) {
  return {
    chapters: [],
    start: -1,
    end: -1,
    swapped: false,
    error: null,
    invalidField: null,
    warnings: [],
    total,
  };
}
