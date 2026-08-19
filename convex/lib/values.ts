// Structural equality for stored field values (partial dates, prices,
// lists, observation snapshots). Shared by the moderation write path
// (no-op detection) and the import pipeline (unchanged-fetch detection).

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
