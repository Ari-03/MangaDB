// Coverage inference for packaging books ("Berserk Deluxe Volume 1",
// "One Piece 3-in-1 Edition Vol. 5") whose title never states which Volumes
// they collect. Without a coverage such a book stays on its observation for
// an Editor (lib/catalogTitle.ts), so the Deluxe/Omnibus reading paths that
// readers come here for never appear. Two further signals fill the gap:
//
//   1. The publisher's own blurb. PRH flap copy and keynotes say "collecting
//      volumes 1–3" or "Collects Berserk Volumes 40, 41"; Yen Press and Seven
//      Seas page text does the same.
//   2. A line name that declares its size: "3-in-1" and VIZBIG (always three
//      volumes) at position p cover volumes 3p-2 … 3p.
//
// Plain "Omnibus" / "Deluxe" with no stated size and no blurb range stays
// unknown: guessing a size would map books onto the wrong Volumes.

import { canonicalLabel, parseVolumeList, type CoverRange, type Packaging } from "./bookTitle";

/** Largest sensible volume number in a coverage statement. */
const MAX_VOLUME = 500;

const VOL = String.raw`vol(?:ume)?s?\.?`;
const NUM = String.raw`\d{1,3}`;
const DASH = String.raw`\s*(?:[-–—]|to|through|thru)\s*`;
// Up to six words between the verb and "volumes": "collects Berserk volumes 1–3",
// "collecting the first three New York Times bestselling volumes" is not matched.
const LEAD = String.raw`(?:collect(?:s|ing|ed)?|contain(?:s|ing)?|includ(?:es|ing)|compil(?:es|ing)|gather(?:s|ing))\s+(?:the\s+)?(?:(?:original\s+)?[\w'’:!?,.-]+\s+){0,6}?`;

const STATED_RANGE = new RegExp(`${LEAD}${VOL}\\s*(${NUM})${DASH}(${NUM})`, "i");
// "Collects volumes 40, 41, and the Guidebook" → the listed numbers, when
// they run without a gap ("volumes 1 and 3" states no range).
const STATED_LIST = new RegExp(
  `${LEAD}${VOL}\\s*(${NUM}(?:\\s*,\\s*${NUM})*(?:\\s*,?\\s*(?:and|&)\\s*${NUM})?)`,
  "i",
);
// A bare "Volumes 1–3" anywhere: weaker, so it comes last.
const BARE_RANGE = new RegExp(`\\b${VOL}\\s*(${NUM})${DASH}(${NUM})\\b`, "i");

function range(from: number, to: number): CoverRange | null {
  if (!(from >= 1 && to >= from && to <= MAX_VOLUME && to - from < 50)) return null;
  return { from: canonicalLabel(String(from)), to: canonicalLabel(String(to)) };
}

/** Strip markup and entities so patterns see plain prose. */
function plain(text: string): string {
  return text
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&ndash;|&#8211;/g, "–")
    .replace(/&mdash;|&#8212;/g, "—")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

/**
 * The Volumes a blurb says the book collects, when it says. A stated list
 * with a gap ("collects volumes 1 and 3") is no range: null, never 1–3.
 */
export function coverageFromText(text: string | undefined): CoverRange | null {
  if (!text) return null;
  const prose = plain(text);
  const stated = STATED_RANGE.exec(prose);
  if (stated) return range(Number(stated[1]), Number(stated[2]));
  const list = STATED_LIST.exec(prose);
  if (list) {
    const listed = parseVolumeList(list[1]!);
    if (listed === null) return range(Number(list[1]), Number(list[1]));
    const { coverRange } = listed;
    return coverRange ? range(Number(coverRange.from), Number(coverRange.to)) : null;
  }
  const bare = BARE_RANGE.exec(prose);
  if (bare) return range(Number(bare[1]), Number(bare[2]));
  return null;
}

/**
 * Volumes per book when the line NAME guarantees it, per the 2026-09-27
 * publisher survey (docs/research): every book of these lines collects the
 * same count. Names whose size varies by series — "Deluxe" (1–3 across
 * publishers), "Collector's Edition" (1.3–3), "Perfect Edition", plain
 * "Omnibus" (2 or 3), kanzenban recuts like "Fullmetal Edition" — return
 * null and wait for a blurb or a Moderator.
 */
const FIXED_LINE_SIZES: Array<[RegExp, number]> = [
  [/\bvizbig\b/i, 3], // VIZ: "collects the material from three standard volumes"
  [/\bcolossal\s+edition\b/i, 5], // Kodansha, Attack on Titan
  [/\bmaster['’]s\s+edition\b/i, 5], // Kodansha, Fairy Tail (Vertical's "Master Edition" varies)
  [/\bgrimoire\s+edition\b/i, 3], // Kodansha, Witch Hat Atelier
  [/\bblack\s+edition\b/i, 2], // VIZ, Death Note
  [/\blegendary\s+edition\b/i, 2], // VIZ, The Legend of Zelda
  [/\bdefinitive\s+(?:hardcover\s+)?(?:edition|collection)\b/i, 3], // VIZ Vagabond, Kodansha AoT
];

export function declaredLineSize(lineName: string | null): number | null {
  if (lineName === null) return null;
  const nIn1 = /\b(\d)-in-1\b/i.exec(lineName);
  if (nIn1) return Number(nIn1[1]);
  for (const [pattern, size] of FIXED_LINE_SIZES) {
    if (pattern.test(lineName)) return size;
  }
  return null;
}

/** "3-in-1 Edition" at position 5 → volumes 13–15; null without a declared size or an integer position. */
export function coverageFromLine(
  lineName: string | null,
  linePosition: string | null,
): CoverRange | null {
  const size = declaredLineSize(lineName);
  if (size === null || linePosition === null || !/^\d{1,3}$/.test(linePosition)) return null;
  const position = Number(linePosition);
  return range(size * (position - 1) + 1, size * position);
}

/**
 * The coverage to place a packaged book by: the title's own statement,
 * else the blurb's, else the line's declared size. `texts` are the source's
 * blurbs in order of trust (PRH: flap copy, positioning, keynote).
 */
export function inferCoverage(
  packaging: Packaging,
  texts: Array<string | undefined>,
): CoverRange | null {
  if (packaging.coverRange) return packaging.coverRange;
  for (const text of texts) {
    const found = coverageFromText(text);
    if (found) return found;
  }
  return coverageFromLine(packaging.lineName, packaging.linePosition);
}
