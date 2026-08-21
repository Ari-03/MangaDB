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
// The publisher list errs broad — the importer's matching ladder and
// authority rules do the precise work; this pass only cuts ~50M lines down
// to the plausible ones.

import { createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";

const MANGA_PUBLISHERS =
  /viz media|viz communications|viz, llc|kodansha|seven seas|yen press|ize press|dark horse|square enix|vertical|denpa|tokyopop|del rey manga|udon entertainment|one peace books|kaiten books|j-novel|drawn (?:&|and) quarterly|fantagraphics|seven seas entertainment|shonen jump|titan manga|ablaze|mixx|cmx|delcourt|glacier bay|star fruit books|fakku|irodori|manga classics|comicsone|digital manga|dmp|netcomics|823 press|kuma|last gasp/i;

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
  // Cheap substring test on the raw JSON column before any parsing.
  const publishersAt = line.indexOf('"publishers"');
  if (publishersAt < 0) continue;
  const slice = line.slice(publishersAt, publishersAt + 400);
  if (!MANGA_PUBLISHERS.test(slice)) continue;
  process.stdout.write(line + "\n");
  kept++;
}

console.error(`kept ${kept} of ${total} lines`);
