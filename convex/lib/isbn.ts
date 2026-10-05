// ISBN normalization shared by the import parsers (ANN, Kodansha, Yen
// Press, OpenLibrary). PRH and Seven Seas read their own ISBN fields without
// a checksum test (lib/prh.ts asIsbn13, lib/sevenSeas.ts parseBookPage).

/** Does this 13-digit string carry a valid ISBN-13 check digit? */
export function isbn13CheckOk(isbn13: string): boolean {
  const sum = [...isbn13].reduce((acc, d, i) => acc + Number(d) * (i % 2 === 0 ? 1 : 3), 0);
  return sum % 10 === 0;
}

/** ISBN-10 → its ISBN-13 (978 prefix, recomputed check digit). */
export function isbn10To13(isbn10: string): string {
  const core = `978${isbn10.slice(0, 9)}`;
  const sum = [...core].reduce((acc, d, i) => acc + Number(d) * (i % 2 === 0 ? 1 : 3), 0);
  return `${core}${(10 - (sum % 10)) % 10}`;
}

/** A 978 ISBN-13 → its ISBN-10; a 979 ISBN has none (undefined). */
export function isbn13To10(isbn13: string): string | undefined {
  if (!/^978\d{10}$/.test(isbn13)) return undefined;
  const core = isbn13.slice(3, 12);
  const sum = [...core].reduce((acc, d, i) => acc + Number(d) * (10 - i), 0);
  const check = (11 - (sum % 11)) % 11;
  return `${core}${check === 10 ? "X" : String(check)}`;
}

/**
 * Any ISBN spelling → a checksum-valid ISBN-13: a 13-digit form as is, a
 * 10-character form converted. Hyphens and spaces are ignored; anything
 * else (an SKU, a UPC, a bad check digit) is undefined.
 */
export function toIsbn13(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const chars = raw.replace(/[\s-]/g, "").toUpperCase();
  if (/^(?:978|979)\d{10}$/.test(chars)) return isbn13CheckOk(chars) ? chars : undefined;
  if (/^\d{9}[\dX]$/.test(chars)) {
    const sum = [...chars].reduce((acc, c, i) => acc + (c === "X" ? 10 : Number(c)) * (10 - i), 0);
    return sum % 11 === 0 ? isbn10To13(chars) : undefined;
  }
  return undefined;
}
