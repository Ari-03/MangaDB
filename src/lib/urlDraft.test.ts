import { describe, expect, it } from "vitest";

import { landView, requestView, type Pending } from "./urlDraft";

/** Runs requests and landings in order, as the hook would, from `shown`. */
function play(shown: string, steps: Array<["request" | "land", string]>) {
  let pending: Pending = [];
  const log: Array<string> = [];
  for (const [kind, key] of steps) {
    if (kind === "request") {
      const next = requestView(pending, shown, key);
      log.push(next ? `go ${key}` : `skip ${key}`);
      if (next) pending = next;
    } else {
      shown = key;
      const next = landView(pending, key);
      pending = next.pending;
      log.push(next.outside ? `outside ${key}` : `echo ${key}`);
    }
  }
  return { log, pending };
}

describe("useUrlDraft's bookkeeping", () => {
  it("skips a navigation to the view already asked for or shown", () => {
    expect(play("B", [["request", "B"]]).log).toEqual(["skip B"]);
    expect(play("B", [["request", "K1"], ["request", "K1"]]).log).toEqual(["go K1", "skip K1"]);
  });

  it("takes a superseded request landing late for an echo", () => {
    // Typing asks for K1 then K2; K1 lands after K2 was asked for.
    const run = play("B", [["request", "K1"], ["request", "K2"], ["land", "K1"], ["land", "K2"]]);
    expect(run.log).toEqual(["go K1", "go K2", "echo K1", "echo K2"]);
    expect(run.pending).toEqual([]);
  });

  it("drops older requests when a newer one lands first", () => {
    const run = play("B", [["request", "K1"], ["request", "K2"], ["land", "K2"], ["land", "K1"]]);
    // K1 can no longer be the page's own once K2 has landed.
    expect(run.log).toEqual(["go K1", "go K2", "echo K2", "outside K1"]);
  });

  it("replaces the draft when Clear all lands on the view shown while a filter is pending", () => {
    // On B, a filter asks for K1; before it lands a link resolves to B.
    const run = play("B", [["request", "K1"], ["land", "B"]]);
    expect(run.log).toEqual(["go K1", "outside B"]);
    expect(run.pending).toEqual([]);
    // Nothing stale is left to swallow later outside navigations.
    expect(play("B", [["request", "K1"], ["land", "B"], ["land", "K1"], ["land", "B"]]).log).toEqual([
      "go K1",
      "outside B",
      "outside K1",
      "outside B",
    ]);
  });

  it("counts a request back to the view shown as the page's own", () => {
    // A filter picked then unpicked: K1, then B again, both in flight.
    const run = play("B", [["request", "K1"], ["request", "B"], ["land", "B"]]);
    expect(run.log).toEqual(["go K1", "go B", "echo B"]);
    expect(run.pending).toEqual([]);
  });

  it("settles through the latest request of a repeated view", () => {
    const run = play("B", [["request", "A"], ["request", "C"], ["request", "A"], ["land", "A"]]);
    expect(run.log.at(-1)).toBe("echo A");
    expect(run.pending).toEqual([]);
  });
});
