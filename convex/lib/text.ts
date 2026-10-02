// Shared wire-text plumbing for import parsers: HTML/XML entity decoding
// and tag stripping. Pure, so every adapter's parser stays unit-testable
// against fixture responses without a backend.

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  lpar: "(",
  rpar: ")",
  lsqb: "[",
  rsqb: "]",
  lbrack: "[",
  rbrack: "]",
  lcub: "{",
  rcub: "}",
  comma: ",",
  period: ".",
  colon: ":",
  semi: ";",
  excl: "!",
  quest: "?",
  num: "#",
  percnt: "%",
  ast: "*",
  plus: "+",
  equals: "=",
  sol: "/",
  bsol: "\\",
  hyphen: "-",
  dash: "‐",
  ndash: "–",
  mdash: "—",
  lsquo: "‘",
  rsquo: "’",
  sbquo: "‚",
  ldquo: "“",
  rdquo: "”",
  bdquo: "„",
  laquo: "«",
  raquo: "»",
  hellip: "…",
  middot: "·",
  bull: "•",
  times: "×",
  divide: "÷",
  deg: "°",
  copy: "©",
  reg: "®",
  trade: "™",
  infin: "∞",
  star: "☆",
  starf: "★",
  hearts: "♥",
  frac12: "½",
  frac14: "¼",
  frac34: "¾",
  sup2: "²",
  sup3: "³",
  iexcl: "¡",
  iquest: "¿",
  szlig: "ß",
  oslash: "ø",
  Oslash: "Ø",
  aelig: "æ",
  AElig: "Æ",
  oelig: "œ",
  OElig: "Œ",
  eth: "ð",
  thorn: "þ",
  zwj: "",
  zwnj: "",
  shy: "",
};

// "eacute", "Uuml", "ccedil"… → base letter + combining mark, composed.
const ACCENT_MARKS: Record<string, string> = {
  acute: "́",
  grave: "̀",
  circ: "̂",
  uml: "̈",
  tilde: "̃",
  ring: "̊",
  cedil: "̧",
  macr: "̄",
  caron: "̌",
};

function namedEntity(name: string): string | undefined {
  const direct = NAMED_ENTITIES[name];
  if (direct !== undefined) return direct;
  const accented = /^([a-zA-Z])(acute|grave|circ|uml|tilde|ring|cedil|macr|caron)$/.exec(name);
  if (!accented) return undefined;
  return `${accented[1]}${ACCENT_MARKS[accented[2]!]}`.normalize("NFC");
}

function decodeOnce(text: string): string {
  return text
    .replace(/&#(\d+);/g, (m, code: string) => {
      const n = Number(code);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    })
    .replace(/&#[xX]([0-9a-fA-F]+);/g, (m, code: string) => {
      const n = parseInt(code, 16);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    })
    .replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (m, name: string) => namedEntity(name) ?? m);
}

/**
 * Decode the HTML/XML entities WordPress and ANN emit in titles and text.
 * Repeats to a fixpoint (at most 3 passes): ANN's XML double-escapes, so
 * "&amp;#40;" must become "(" rather than a literal "&#40;".
 */
export function decodeEntities(text: string): string {
  let current = text;
  for (let pass = 0; pass < 3; pass++) {
    const next = decodeOnce(current);
    if (next === current) break;
    current = next;
  }
  return current;
}

/** Strip tags, decode entities, and collapse whitespace to one line of text. */
export function stripHtml(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/** The longest blurb kept; publisher copy runs 300–2,000 characters. */
export const MAX_BLURB = 4000;

// Tags that break text: they become a space, while inline tags (<i>, <b>,
// <a>…) vanish so "<i>Akira</i>," stays "Akira,".
const BREAKING_TAG = /<\/?(?:p|br|div|li|ul|ol|h[1-6]|blockquote|table|tr|td|th|section)\b[^>]*>/gi;

// Windows-1252's characters for bytes 0x80–0x9F (its five undefined slots
// pass through as the same C1 control code points), so mojibake can be
// turned back into the UTF-8 bytes it came from.
const CP1252_HIGH = "€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008DŽ\u008F\u0090‘’“”•–—˜™š›œ\u009DžŸ";
// A UTF-8 lead byte read as Windows-1252 (Â–ô), followed by exactly the
// continuation bytes it needs (0x80–0xBF read the same way): "â€™" is ’.
const CONT = `[${CP1252_HIGH}\u00A0-\u00BF]`;
const MOJIBAKE = new RegExp(
  `[\u00C2-\u00DF]${CONT}|[\u00E0-\u00EF]${CONT}{2}|[\u00F0-\u00F4]${CONT}{3}`,
  "g",
);
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });

/**
 * Undo UTF-8 text that was decoded as Windows-1252 somewhere upstream
 * ("Tsukasaâ€™s" → "Tsukasa’s"). Only a run shaped exactly like an encoded
 * character is re-decoded, and only when its bytes are valid UTF-8, so a
 * real "â" or "Ã" in clean text ("pâté", "Ã la") is left alone.
 */
export function repairMojibake(text: string): string {
  return text.replace(MOJIBAKE, (run) => {
    const bytes = Uint8Array.from(run, (ch) => {
      const code = ch.charCodeAt(0);
      return code <= 0xff ? code : 0x80 + CP1252_HIGH.indexOf(ch);
    });
    try {
      return STRICT_UTF8.decode(bytes);
    } catch {
      return run;
    }
  });
}

/**
 * A source's blurb (HTML or plain text) → one clean paragraph for a Release
 * Description or Series synopsis: tags stripped, entities decoded,
 * whitespace collapsed, mojibake repaired (`repairMojibake`), capped at
 * MAX_BLURB on a word boundary so snapshots stay small. Anything empty or
 * non-string is undefined: an adapter offers nothing rather than "".
 */
export function cleanBlurb(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const text = repairMojibake(decodeEntities(raw.replace(BREAKING_TAG, " ").replace(/<[^>]*>/g, "")))
    .replace(/\s+/g, " ")
    .trim();
  if (text === "") return undefined;
  if (text.length <= MAX_BLURB) return text;
  const cut = text.slice(0, MAX_BLURB - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > MAX_BLURB * 0.8 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

// Inline markup ANN leaks into titles. Only these known tag names are
// unwrapped, so a real title with angle brackets ("<Infinite Dendrogram>")
// survives.
const INLINE_TAG = /<\/?(?:ruby|rb|rt|rp|rtc|sup|sub|i|b|em|strong|span|small|br)\b[^>]*>/gi;

/**
 * One-line title text from a wire payload: entities decoded, ruby
 * annotations (`<rt>`/`<rp>`) dropped with their base text kept, inline tags
 * unwrapped, whitespace collapsed.
 */
export function cleanTitleText(raw: string): string {
  return decodeEntities(raw)
    .replace(/<(rt|rp)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(INLINE_TAG, "")
    .replace(/[\s ]+/g, " ")
    .trim();
}
