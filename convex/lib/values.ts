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

/** First non-JSON value that valueHash cannot distinguish exactly. */
export function nonJsonPath(value: unknown, path = "snapshot"): string | null {
  if (value === null || typeof value === "string" || typeof value === "boolean") return null;
  if (typeof value === "number") {
    return Number.isFinite(value) && !Object.is(value, -0) ? null : path;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const found = nonJsonPath(value[i], `${path}[${i}]`);
      if (found !== null) return found;
    }
    return null;
  }
  if (typeof value !== "object") return path;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return path;
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    const found = nonJsonPath(item, `${path}.${key}`);
    if (found !== null) return found;
  }
  return null;
}
