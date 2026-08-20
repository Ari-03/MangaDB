// Pure quality-gate helpers for the launch QA tooling (ticket #40, spec §7):
// the title-similarity duplicate sweep and the random-sample reservoir.
// Pure so both are unit-testable without a backend; the paging/writes live
// in convex/launch.ts.

import { normalizeTitle } from "./matching";

// ---------- title-similarity duplicate sweep ----------

export type SweepEntry = {
  id: string;
  title: string;
  altTitles: string[];
};

export type SweepPair = {
  aId: string;
  bId: string;
  reason: string;
};

// Tokens that never distinguish two Series titles: articles plus the medium
// disambiguators sources append ("Berserk" vs "Berserk Manga").
const STOP_TOKENS = new Set(["the", "a", "an", "manga", "comic", "comics"]);

/** Order-insensitive title key: sorted tokens minus stop words. */
export function tokenKey(title: string): string {
  const tokens = normalizeTitle(title)
    .split(" ")
    .filter((t) => t.length > 0 && !STOP_TOKENS.has(t));
  return tokens.sort().join(" ");
}

/** Every comparable key one Series offers: its title and every alt title. */
function keysOf(entry: SweepEntry): Array<{ key: string; reason: string }> {
  const keys: Array<{ key: string; reason: string }> = [];
  for (const title of [entry.title, ...entry.altTitles]) {
    const exact = normalizeTitle(title);
    if (exact) keys.push({ key: `t:${exact}`, reason: "identical normalized title" });
    const sorted = tokenKey(title);
    if (sorted) keys.push({ key: `k:${sorted}`, reason: "same title tokens" });
  }
  return keys;
}

/** Stable pair identity regardless of comparison order. */
export function pairKeyOf(aId: string, bId: string): string {
  return aId < bId ? `${aId}|${bId}` : `${bId}|${aId}`;
}

/**
 * The title-similarity sweep (QA gate ③): flag every pair of Series whose
 * normalized titles (or alt titles) collide — exactly, or as the same token
 * set once articles/medium words are dropped ("Fullmetal Alchemist Manga" ≈
 * "Fullmetal Alchemist"). Key-blocked, so a full-catalog sweep stays linear;
 * every flagged pair is a human review item, never an auto-merge (the
 * importer — and the sweep — never initiates a merge, spec §6).
 */
export function findDuplicatePairs(entries: SweepEntry[]): SweepPair[] {
  const byKey = new Map<string, Array<{ id: string; reason: string }>>();
  for (const entry of entries) {
    // One id offers each key at most once (title and alt often share keys).
    const seen = new Set<string>();
    for (const { key, reason } of keysOf(entry)) {
      if (seen.has(key)) continue;
      seen.add(key);
      const bucket = byKey.get(key);
      if (bucket) bucket.push({ id: entry.id, reason });
      else byKey.set(key, [{ id: entry.id, reason }]);
    }
  }
  const pairs = new Map<string, SweepPair>();
  for (const bucket of byKey.values()) {
    if (bucket.length < 2) continue;
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const a = bucket[i]!;
        const b = bucket[j]!;
        if (a.id === b.id) continue;
        const key = pairKeyOf(a.id, b.id);
        // Exact-title collisions outrank token-set collisions in the reason.
        const existing = pairs.get(key);
        if (existing && existing.reason === "identical normalized title") continue;
        pairs.set(key, {
          aId: a.id < b.id ? a.id : b.id,
          bId: a.id < b.id ? b.id : a.id,
          reason: a.reason,
        });
      }
    }
  }
  return [...pairs.values()];
}

// ---------- random-sample reservoir ----------

/**
 * Classic reservoir sampling: feed it every candidate (across however many
 * paginated reads) and it holds a uniform k-sample at the end. `random`
 * injects the RNG so tests are deterministic.
 */
export class Reservoir<T> {
  private items: T[] = [];
  private seen = 0;

  constructor(
    private readonly k: number,
    private readonly random: () => number = Math.random,
  ) {}

  add(item: T): void {
    this.seen++;
    if (this.items.length < this.k) {
      this.items.push(item);
      return;
    }
    const slot = Math.floor(this.random() * this.seen);
    if (slot < this.k) this.items[slot] = item;
  }

  sample(): T[] {
    return [...this.items];
  }

  get count(): number {
    return this.seen;
  }
}
