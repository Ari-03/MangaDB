#!/usr/bin/env node
// Offline filter for the OpenLibrary editions bulk dump (spec §6: monthly
// cadence; ticket #36). The raw dump (~10 GB gzipped, from
// https://openlibrary.org/developers/dumps) is far too large for a Convex
// action, so this script streams it once and keeps only lines whose edition
// names a manga-relevant English publisher. Host the output somewhere the
// Convex deployment can fetch (any static URL) and set OPENLIBRARY_DUMP_URL.
//
// Usage:
//   node scripts/filter-openlibrary-dump.mjs ol_dump_editions_latest.txt.gz > filtered.txt
//   curl -sL https://openlibrary.org/data/ol_dump_editions_latest.txt.gz \
//     | node scripts/filter-openlibrary-dump.mjs > filtered.txt
//
// The publisher allowlist is anchored per publisher name (a "publishers"
// array entry must START with a manga brand, on a word boundary — "Kuma"
// never matches "Kumar", and a title mentioning "dark horse" never counts),
// and a kept edition must carry an ISBN outside the Japanese group 978-4:
// OpenLibrary's role is ISBN fill, so a record without one cannot do its job.
// The importer's matching ladder and authority rules do the precise work;
// this pass only cuts ~50M lines down to the plausible ones.

import { createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";

const MANGA_PUBLISHERS = [
  /^viz\b/i,
  /^kodansha\b/i,
  /^(?:brand:\s*)?seven seas\b/i,
  /^yen press\b/i,
  /^ize press\b/i,
  /^dark horse\b/i,
  /^square enix\b/i,
  /^vertical\b/i,
  /^denpa\b/i,
  /^tokyopop\b/i,
  /^del rey manga\b/i,
  /^udon entertainment\b/i,
  /^one peace books\b/i,
  /^kaiten books\b/i,
  /^j-novel\b/i,
  /^drawn (?:&|and) quarterly\b/i,
  /^fantagraphics\b/i,
  /^shonen jump\b/i,
  /^titan manga\b/i,
  /^ablaze\b/i,
  /^mixx\b/i,
  /^cmx\b/i,
  /^glacier bay\b/i,
  /^star fruit books\b/i,
  /^fakku\b/i,
  /^irodori\b/i,
  /^manga classics\b/i,
  /^comicsone\b/i,
  /^digital manga\b/i,
  /^dmp\b/i,
  /^netcomics\b/i,
  /^823 press\b/i,
  /^kuma\b/i,
  /^last gasp\b/i,
  // VIZ imprint labels OpenLibrary records as the publisher.
  /^shojo beat\b/i,
  /^sublime\b/i,
  // Legacy publishers with catalog rows (lib/publishers.ts) — their books
  // can land now that the rows exist.
  /^adv manga\b/i,
  /^aurora publishing\b/i,
  /^central park media\b/i,
  /^cpm manga\b/i,
  /^go!? ?comi\b/i,
  /^broccoli books\b/i,
  /^dr\.? ?master\b/i,
  /^drama ?queen\b/i,
  /^media blasters\b/i,
  /^801 media\b/i,
  /^blu(?: manga)?$/i,
  /^icarus publishing\b/i,
  /^project-h\b/i,
  // Deliberately absent: "Del Rey"/"Ballantine" and "Yen On" — prose
  // lines that would resolve onto their manga siblings.
];

/** Does one parsed edition name a manga publisher and carry a usable ISBN? */
function keep(edition) {
  const publishers = Array.isArray(edition.publishers) ? edition.publishers : [];
  const named = publishers.some(
    (name) =>
      typeof name === "string" &&
      MANGA_PUBLISHERS.some((brand) => brand.test(name.trim())),
  );
  if (!named) return false;
  const isbns = [
    ...(Array.isArray(edition.isbn_13) ? edition.isbn_13 : []),
    ...(Array.isArray(edition.isbn_10) ? edition.isbn_10 : []),
  ].map((isbn) => String(isbn).replace(/[^0-9Xx]/g, ""));
  // 978-4 / ISBN-10 group 4 is Japan: never an English edition.
  return isbns.some((isbn) => isbn !== "" && !/^(?:9784|4\d{9}$)/.test(isbn));
}

const input = process.argv[2];
const raw = input ? createReadStream(input) : process.stdin;

// Sniff the gzip magic bytes (1f 8b) instead of trusting the filename, so
// piped stdin (`curl … .txt.gz | node …`) is decompressed too.
const firstChunk = await new Promise((resolve, reject) => {
  raw.once("error", reject);
  raw.once("readable", () => resolve(raw.read()));
});
if (firstChunk) raw.unshift(firstChunk);
const isGzip =
  firstChunk && firstChunk.length >= 2 && firstChunk[0] === 0x1f && firstChunk[1] === 0x8b;
const stream = isGzip ? raw.pipe(createGunzip()) : raw;

const lines = createInterface({ input: stream, crlfDelay: Infinity });
let kept = 0;
let total = 0;

for await (const line of lines) {
  total++;
  if (!line.startsWith("/type/edition\t")) continue;
  // Cheap substring tests on the raw line before parsing any JSON.
  if (!line.includes('"publishers"') || !line.includes('"isbn_1')) continue;
  const json = line.split("\t").slice(4).join("\t");
  let edition;
  try {
    edition = JSON.parse(json);
  } catch {
    continue;
  }
  if (!keep(edition)) continue;
  process.stdout.write(line + "\n");
  kept++;
}

console.error(`kept ${kept} of ${total} lines`);
