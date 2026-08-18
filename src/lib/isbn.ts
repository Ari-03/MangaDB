// ISBN recognition for search (ticket #38, spec §8/§11): a query the user
// types into /search that is a valid ISBN never runs a text search — it
// redirects through the `/isbn/{isbn}` route, which owns resolution to the
// owning Edition (or Bundle) page (ticket #23). Recognition is strict
// (checksum-verified, and 978/979-prefixed for ISBN-13) so a numeric title
// query is never hijacked by a near-miss.

/** Strip hyphen/space separators and uppercase the ISBN-10 check character. */
function compact(input: string): string {
  return input.replace(/[\s-]+/g, "").toUpperCase();
}

/** Checksum-valid, Bookland-prefixed (978/979) 13-digit ISBN. */
export function isValidIsbn13(compacted: string): boolean {
  if (!/^97[89][0-9]{10}$/.test(compacted)) return false;
  let sum = 0;
  for (let i = 0; i < 13; i++) {
    sum += Number(compacted[i]) * (i % 2 === 0 ? 1 : 3);
  }
  return sum % 10 === 0;
}

/** Checksum-valid 10-character ISBN; the check character may be X. */
export function isValidIsbn10(compacted: string): boolean {
  if (!/^[0-9]{9}[0-9X]$/.test(compacted)) return false;
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const char = compacted[i];
    sum += (char === "X" ? 10 : Number(char)) * (10 - i);
  }
  return sum % 11 === 0;
}

/**
 * Recognize an input as an ISBN. Returns the normalized form — separators
 * stripped, check character uppercased — ready for the `/isbn/{isbn}` URL
 * segment, or null when the input is not a valid ISBN-10 or ISBN-13.
 */
export function normalizeIsbn(input: string): string | null {
  const compacted = compact(input);
  if (isValidIsbn13(compacted) || isValidIsbn10(compacted)) return compacted;
  return null;
}
