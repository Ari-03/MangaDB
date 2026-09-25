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

/** Strip tags and collapse whitespace — for blurbs kept on the observation. */
export function stripHtml(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
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
