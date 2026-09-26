/*
  Reading a SvelteKit `__data.json` response.

  fenrirealm.com is a SvelteKit application, and it serves the *data* behind a
  page separately from the page's HTML:

      GET /series/{slug}[/{group}]/{number}[.{part}]/__data.json

  That distinction matters right now because the server rendered chapter route
  is returning HTTP 500 for every chapter, while this data route answers 200
  with the full text.  It is also the request the site's own reader makes after
  its app boots, which is why the site reads fine in a browser even though the
  HTML route is broken.  Nothing here is specific to fenrirealm beyond the URL
  shape; the format is SvelteKit's.

  The body is devalue's flattened form inside a SvelteKit envelope:

      {"type":"data","nodes":[ <root>, null, ..., <node> ]}

  Every meaningful entry in `nodes` is `{"type":"data","data":[...]}`.  Within
  one such node, `data[0]` is the value the page was handed, and *every number
  appearing inside it is an index into that same `data` array* rather than a
  literal value - so `{"chapterData":2}` means `data[2]`.  Negative numbers are
  sentinels, the only one that matters here being -1 for undefined.  Real
  numbers are hoisted into the array like everything else, which is why this
  can resolve a value that is a plain number without ambiguity.
*/

"use strict";

/** Thrown when a `__data.json` body cannot be turned into a chapter. */
export class SvelteDataError extends Error {
  constructor(message, kind) {
    super(message);
    this.name = "SvelteDataError";
    /** "redirect" | "error" | "shape" - lets callers explain themselves. */
    this.kind = kind;
  }
}

/**
 * Turn one `{"type":"data","data":[...]}` node into real JavaScript values.
 */
export function unflattenDataNode(node) {
  const values = node?.data;
  if (!Array.isArray(values)) {
    throw new SvelteDataError("Malformed SvelteKit data node.", "shape");
  }
  const resolved = new Map();

  function deref(reference) {
    if (typeof reference !== "number") return reference;
    // -1 undefined, -2 NaN, -3 Infinity, -4 -Infinity, -5 -0
    if (reference < 0) return reference === -1 ? undefined : null;
    if (resolved.has(reference)) return resolved.get(reference);

    const value = values[reference];
    if (value === null || typeof value !== "object") {
      resolved.set(reference, value);
      return value;
    }
    if (Array.isArray(value)) {
      // claim the slot before recursing, so a cycle terminates
      const list = [];
      resolved.set(reference, list);
      for (const item of value) list.push(deref(item));
      return list;
    }
    const object = {};
    resolved.set(reference, object);
    for (const [key, item] of Object.entries(value)) {
      object[key] = deref(item);
    }
    return object;
  }

  return deref(0);
}

/**
 * Parse a `__data.json` body and return the value the page was given.
 *
 * Throws a SvelteDataError for the other envelopes the site uses, so a caller
 * can tell "this chapter is not free" apart from "the site is broken".
 */
export function parseDataResponse(text, url) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new SvelteDataError(
      `${url} did not return JSON. The site may have changed how it serves chapters.`,
      "shape"
    );
  }

  if (payload?.type === "redirect") {
    throw new SvelteDataError(
      payload.location?.includes("/auth")
        ? "The site wants an account to read this chapter, so it is not free."
        : `The site redirected to ${payload.location}.`,
      "redirect"
    );
  }

  if (payload?.type !== "data" || !Array.isArray(payload.nodes)) {
    throw new SvelteDataError(
      `${url} returned an unexpected response (${payload?.type ?? "no type"}).`,
      "shape"
    );
  }

  for (const node of payload.nodes) {
    if (node?.type === "error") {
      throw new SvelteDataError(
        node.error?.message || "The site reported an error for this chapter.",
        "error"
      );
    }
  }

  // the page's own value is whichever node carries something other than the
  // session bookkeeping the root layout always sends
  for (const node of payload.nodes) {
    if (node?.type !== "data") continue;
    const value = unflattenDataNode(node);
    if (value != null && typeof value === "object" && "chapterData" in value) {
      return value;
    }
  }

  throw new SvelteDataError(`${url} did not include any chapter data.`, "shape");
}
