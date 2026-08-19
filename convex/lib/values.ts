// Structural equality and canonical hashing for stored field values
// (partial dates, prices, lists, observation snapshots). Shared by the
// moderation write path (no-op detection) and the import pipeline
// (unchanged-fetch detection, conflict-suppression keys).

export function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((item, i) => sameValue(item, b[i]));
  }
  if (typeof a === "object") {
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const keys = new Set([...Object.keys(aObj), ...Object.keys(bObj)]);
    for (const key of keys) {
      if (!sameValue(aObj[key], bObj[key])) return false;
    }
    return true;
  }
  return false;
}

/**
 * Canonical string form of a field value — the suppression key's valueHash
 * (spec §6: rejected import conflicts are suppressed on record + field +
 * source + offered value). Object keys sort, undefined entries drop, so two
 * values that sameValue() also hash equal.
 */
export function valueHash(value: unknown): string {
  if (value === undefined) return "absent";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(valueHash).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${valueHash(v)}`);
  return `{${entries.join(",")}}`;
}
