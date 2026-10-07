// One retained line of an Open Library monthly editions dump, read as
// evidence. A dump line is a dated bulk-export record, never a live
// response: its revision and last_modified date the record, the dump's
// own date dates the snapshot, and neither says when MangaDB ingested it.
import { parseDumpLine, type OlEditionSnapshot } from "./openLibrary";

/** The bound on one retained line, so a decision stays far inside its 64 KiB. */
export const MAX_DUMP_LINE_BYTES = 16 * 1024;

/** The official dated file and its archive.org origin for one monthly editions dump. */
export function editionsDump(date: string) {
  const file = `ol_dump_editions_${date}.txt.gz`;
  return { file, url: `https://archive.org/download/ol_dump_${date}/${file}` };
}

/** A calendar day "YYYY-MM-DD" that exists, as its UTC midnight, or null. */
export function dayStart(day: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const time = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === day ? time : null;
}

/** Open Library's datetime "YYYY-MM-DDTHH:MM:SS[.ffffff]", read as UTC, or null. */
export function olDateTime(text: string): number | null {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?$/.exec(text);
  const day = match ? dayStart(match[1]!) : null;
  if (!match || day === null) return null;
  const [hours, minutes, seconds] = [match[2], match[3], match[4]].map(Number);
  if (hours === undefined || minutes === undefined || seconds === undefined) return null;
  if (hours > 23 || minutes > 59 || seconds > 59) return null;
  return day + ((hours * 60 + minutes) * 60 + seconds) * 1000;
}

export type DumpLineFacts = {
  type: string;
  key: string;
  revision: string;
  lastModified: string;
  /** The edition JSON exactly as the line carries it. */
  edition: Record<string, unknown>;
  /** The deployed parser's reading of the line; null when it is out of scope. */
  snapshot: OlEditionSnapshot | null;
};

/**
 * The five columns of a dump line, its edition JSON and the deployed
 * parser's snapshot, or the reason the line is unreadable. The JSON is kept
 * raw so a caller can tell an absent field from a null or empty one, which
 * parseEditionJson treats alike.
 */
export function readDumpLine(line: string): DumpLineFacts | string {
  if (/[\r\n]/.test(line)) return "A dump line is one line without its terminator.";
  const columns = line.split("\t");
  if (columns.length !== 5) return "Malformed dump line: expected five tab-separated columns.";
  const [type, key, revision, lastModified, json] = columns as [
    string,
    string,
    string,
    string,
    string,
  ];
  let edition: unknown;
  try {
    edition = JSON.parse(json);
  } catch {
    return "Malformed dump line: the edition column is not JSON.";
  }
  if (!edition || typeof edition !== "object" || Array.isArray(edition))
    return "Malformed dump line: the edition column is not an object.";
  let snapshot: OlEditionSnapshot | null;
  try {
    snapshot = parseDumpLine(line);
  } catch {
    return "Malformed dump line: its envelope or edition identity disagrees.";
  }
  return {
    type,
    key,
    revision,
    lastModified,
    edition: edition as Record<string, unknown>,
    snapshot,
  };
}

// SHA-256 (FIPS 180-4), synchronous so a projection can re-verify a stored
// line without an async guard. Only for retained evidence of bounded size.
const K = Uint32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
type Eight = [number, number, number, number, number, number, number, number];

/** Lowercase hex SHA-256 of a string's UTF-8 bytes. */
export function sha256Hex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const blocks = Math.ceil((bytes.length + 9) / 64);
  const words = new Uint32Array(blocks * 16);
  bytes.forEach((byte, i) => {
    words[i >> 2]! |= byte << (24 - (i % 4) * 8);
  });
  words[bytes.length >> 2]! |= 0x80 << (24 - (bytes.length % 4) * 8);
  words[words.length - 2] = Math.floor(bytes.length / 0x20000000);
  words[words.length - 1] = (bytes.length * 8) >>> 0;
  const hash = Uint32Array.from([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  for (let block = 0; block < blocks; block++) {
    for (let t = 0; t < 64; t++) {
      if (t < 16) {
        w[t] = words[block * 16 + t]!;
        continue;
      }
      const a = w[t - 15]!;
      const b = w[t - 2]!;
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
      w[t] = w[t - 16]! + s0 + w[t - 7]! + s1;
    }
    let [a, b, c, d, e, f, g, h] = Array.from(hash) as Eight;
    for (let t = 0; t < 64; t++) {
      const t1 =
        (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[t]! + w[t]!) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    [a, b, c, d, e, f, g, h].forEach((value, i) => {
      hash[i] = hash[i]! + value;
    });
  }
  return Array.from(hash, (word) => word.toString(16).padStart(8, "0")).join("");
}
