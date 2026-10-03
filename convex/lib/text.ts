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
// What mojibake in English copy decodes to: Latin-1 and Latin Extended-A
// letters (é, ō) and general punctuation (’ “ — …). Anything else (CJK,
// Hebrew, IPA) means the run was real text that only looked encoded.
const REPAIRED = /^[\u00A0-\u017F\u2000-\u206F]$/;

/**
 * Undo UTF-8 text that was decoded as Windows-1252 somewhere upstream
 * ("Tsukasaâ€™s" → "Tsukasa’s"). Only a run shaped exactly like an encoded
 * character is re-decoded, only when its bytes are valid UTF-8, and only
 * when it decodes to a Latin letter or punctuation. Real text that happens
 * to look encoded stays: "pâté", "Ã la", an accented letter before curly
 * punctuation ("café…”", "CLICHÉ”"), "×" before a no-break space. ANN's
 * cleaner (lib/ann.ts) calls it; `cleanBlurb` does not, since other
 * sources never showed the problem.
 */
export function repairMojibake(text: string): string {
  return text.replace(MOJIBAKE, (run) => {
    const bytes = Uint8Array.from(run, (ch) => {
      const code = ch.charCodeAt(0);
      return code <= 0xff ? code : 0x80 + CP1252_HIGH.indexOf(ch);
    });
    try {
      const decoded = STRICT_UTF8.decode(bytes);
      return REPAIRED.test(decoded) ? decoded : run;
    } catch {
      return run;
    }
  });
}

/**
 * C1 control characters (U+0080–U+009F) as the Windows-1252 characters
 * their byte stands for: "Schneider\u0092s" → "Schneider’s". ANN serves
 * some as real code points (a "&#146;" an editor typed). The five bytes
 * Windows-1252 leaves undefined carry nothing and are dropped.
 */
export function mapC1Controls(text: string): string {
  return text.replace(/[\u0080-\u009F]/g, (ch) => {
    const mapped = CP1252_HIGH[ch.charCodeAt(0) - 0x80]!;
    return mapped === ch ? "" : mapped;
  });
}

/**
 * Page bytes → text: strict UTF-8, or, where a byte sequence is not valid
 * UTF-8, that sequence read as Windows-1252 (legacy bytes pasted into a
 * UTF-8 page), instead of the U+FFFD `Response.text()` would leave.
 */
export function decodeUtf8OrWindows1252(bytes: Uint8Array): string {
  try {
    return STRICT_UTF8.decode(bytes);
  } catch {
    let out = "";
    let at = 0;
    while (at < bytes.length) {
      const lead = bytes[at]!;
      if (lead < 0x80) {
        out += String.fromCharCode(lead);
        at += 1;
        continue;
      }
      const width = lead >= 0xc2 && lead <= 0xdf ? 2 : lead >= 0xe0 && lead <= 0xef ? 3 : lead >= 0xf0 && lead <= 0xf4 ? 4 : 0;
      if (width > 0) {
        try {
          out += STRICT_UTF8.decode(bytes.subarray(at, at + width));
          at += width;
          continue;
        } catch {
          // Not a whole UTF-8 sequence: fall through to one legacy byte.
        }
      }
      out += lead <= 0x9f ? CP1252_HIGH[lead - 0x80]! : String.fromCharCode(lead);
      at += 1;
    }
    return out;
  }
}

/**
 * A source's blurb (HTML or plain text) → one clean paragraph for a Release
 * Description or Series synopsis: tags stripped, entities decoded,
 * whitespace collapsed, capped at MAX_BLURB on a word boundary so snapshots
 * stay small. Anything empty or non-string is undefined: an adapter offers
 * nothing rather than "".
 */
export function cleanBlurb(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const text = decodeEntities(raw.replace(BREAKING_TAG, " ").replace(/<[^>]*>/g, ""))
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
