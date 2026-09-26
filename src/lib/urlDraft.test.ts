import { describe, expect, it } from "vitest";

import {
  requestView,
  startView,
  type Navigation,
  type Pending,
  type SearchParams,
} from "./urlDraft";

// A page whose view is the `q` param, keyed by it, at /p.
const read = (search: SearchParams) => (typeof search.q === "string" ? search.q : "");
const keyOf = (view: string) => view;
const at = (q: string, hash = "", pathname = "/p") => ({
  pathname,
  searchStr: q ? `?q=${q}` : "",
  search: q ? { q } : {},
  hash,
});

/** A navigation from `from` to `to`, as the router's event reports it. */
function nav(from: ReturnType<typeof at> | undefined, to: ReturnType<typeof at>): Navigation {
  return { fromLocation: from, toLocation: to, hashChanged: from?.hash !== to.hash };
}

/**
 * Plays requests and navigation starts in order, as the hook would, on a
 * page showing `shown`; logs what each did.
 */
function play(shown: string, steps: Array<["request", string] | ["start", Navigation]>) {
  let pending: Pending = [];
  let heading = shown;
  const log: Array<string> = [];
  for (const step of steps) {
    if (step[0] === "request") {
      const next = requestView(pending, heading, step[1]);
      log.push(next ? `go ${step[1]}` : `skip ${step[1]}`);
      if (next) pending = next;
      continue;
    }
    const start = startView(pending, step[1], read, keyOf);
    if (start.kind === "own") {
      pending = start.pending;
      heading = start.key;
      log.push(`own ${start.key}`);
    } else if (start.kind === "outside") {
      pending = [];
      heading = start.key;
      log.push(`outside ${start.view}`);
    } else {
      if (start.kind === "leave") pending = [];
      log.push(start.kind);
    }
  }
  return { log, pending };
}

describe("useUrlDraft's bookkeeping", () => {
  it("skips a navigation to the view already asked for or shown", () => {
    expect(play("b", [["request", "b"]]).log).toEqual(["skip b"]);
    expect(play("b", [["request", "k1"], ["request", "k1"]]).log).toEqual(["go k1", "skip k1"]);
  });

  it("takes the page's own navigations for its own, superseded ones included", () => {
    // Typing asks for k1 then k2 before k1 starts; both start in order.
    const run = play("b", [
      ["request", "k1"],
      ["request", "k2"],
      ["start", nav(at("b"), at("k1"))],
      ["start", nav(at("b"), at("k2"))],
    ]);
    expect(run.log).toEqual(["go k1", "go k2", "own k1", "own k2"]);
    expect(run.pending).toEqual([]);
  });

  it("counts a request back to the view shown as the page's own", () => {
    // A filter picked then unpicked: k1, then b again.
    const run = play("b", [
      ["request", "k1"],
      ["start", nav(at("b"), at("k1"))],
      ["request", "b"],
      ["start", nav(at("b"), at("b"))],
    ]);
    expect(run.log).toEqual(["go k1", "own k1", "go b", "own b"]);
  });

  it("replaces the draft on a link to the URL already shown", () => {
    // Typing is still waiting to navigate; the "All" link reloads b in place.
    const run = play("b", [["start", nav(at("b"), at("b"))]]);
    expect(run.log).toEqual(["outside b"]);
    // Then typing back to b has nothing to do.
    expect(play("b", [["start", nav(at("b"), at("b"))], ["request", "b"]]).log).toEqual([
      "outside b",
      "skip b",
    ]);
  });

  it("replaces the draft when Clear all starts while a filter is on its way", () => {
    const run = play("b", [
      ["request", "k1"],
      ["start", nav(at("b"), at("k1"))],
      ["start", nav(at("b"), at(""))],
    ]);
    expect(run.log).toEqual(["go k1", "own k1", "outside "]);
    expect(run.pending).toEqual([]);
  });

  it("replaces the draft on back and forward", () => {
    const run = play("k1", [["start", nav(at("k1"), at("b"))], ["start", nav(at("b"), at("k1"))]]);
    expect(run.log).toEqual(["outside b", "outside k1"]);
  });

  it("drops what is pending when the page is left", () => {
    const run = play("b", [["request", "k1"], ["start", nav(at("b"), at("", "", "/elsewhere"))]]);
    expect(run.log).toEqual(["go k1", "leave"]);
    expect(run.pending).toEqual([]);
  });

  it("ignores the first load after hydration and a hash-only change", () => {
    const run = play("b", [
      ["request", "k1"],
      ["start", nav(undefined, at("b"))],
      ["start", nav(at("b"), at("b", "top"))],
    ]);
    expect(run.log).toEqual(["go k1", "ignore", "ignore"]);
    expect(run.pending).toEqual(["k1"]);
  });
});
