// Decision evidence is separate from the display parser's preferred label.
// Read technical clauses independently; prose and the authentic work name
// do not become Volume, Binding or Format statements.
import { canonicalLabel, parseBookTitle } from "./bookTitle";
import { decodeEntities } from "./text";

const BINDING =
  /\bhard\s?(?:cover|back|bound)\b|\b(?:paper\s?back|soft\s?(?:cover|back|bound))\b/gi;
export type KnownBinding = "hardcover" | "paperback";

/** All known tokens in a dedicated Binding/physical-format field, including conflicts. */
export function bindingFacts(value: unknown): KnownBinding[] {
  if (typeof value !== "string") return [];
  return Array.from(value.matchAll(BINDING), ([token]) =>
    /^hard/i.test(token) ? "hardcover" : "paperback",
  );
}

const key = (text: string) =>
  decodeEntities(text).normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();

/** Remove only a complete known work prefix, longest first, before reading technical text. */
function outsideWork(text: string, names: readonly string[]): string {
  const clean = text.normalize("NFC").replace(/\s+/g, " ").trim();
  const normalized = clean.toLowerCase();
  const name = names
    .map(key)
    .filter(
      (name) =>
        name !== "" &&
        normalized.startsWith(name) &&
        (name.length === normalized.length || /[\s,:;()[\]{}]/.test(normalized[name.length]!)),
    )
    .sort((a, b) => b.length - a.length)[0];
  if (name === undefined) return clean;
  // Lowercasing can expand a Unicode character. Map the matched prefix
  // back to the original text so a work name never swallows a clause.
  let end = 0;
  let foldedLength = 0;
  for (const char of clean) {
    if (foldedLength >= name.length) break;
    foldedLength += char.toLowerCase().length;
    end += char.length;
  }
  return clean.slice(end);
}

/** A Roman numeral after an explicit marker is a label even in lower case. */
function volumeLabel(value: string): string {
  return canonicalLabel(/^[ivx]+$/i.test(value) ? value.toUpperCase() : value);
}

const LABEL =
  "(?:\\d+(?:\\.\\d+)?(?:\\+\\d+)?|[A-Z]\\d{1,2}|[IVX]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)";
const MARKER = "(?:vol(?:ume)?s?\\.?|volumen|book|part|#)";
const CONTENTS = "(?:(?:includes?|including|collects?|collecting|contains?|containing)\\s+)";
const VOLUME = new RegExp(`^(${CONTENTS})?${MARKER}\\s*#?(${LABEL})(?!\\w|\\.\\d)`, "i");
const LIST_ITEM = new RegExp(
  `^\\s*(?:[-–—&,/]|\\b(?:and|to|through)\\b|\\+\\s*(?=vol|#))\\s*(?:and\\s+)?(?:${MARKER}\\s*)?#?(${LABEL})(?!\\w|\\.\\d)`,
  "i",
);
const EXPLICIT_VOLUME = new RegExp(
  `^(?:${CONTENTS}${MARKER}|(?:vol(?:ume)?s?\\.?|volumen|#)(?=\\s|\\d|\\.|$)|(?:book|part)\\s*[#?\\d])`,
  "i",
);
const BINDING_CLAUSE =
  /^(?:(?:trade|mature)\s+)?(?:hard\s?(?:cover|back|bound)|paper\s?back|soft\s?(?:cover|back|bound))(?:\s+(?:edition|version|binding|format))?(?=\b|\d)/i;
const DIGITAL_CLAUSE =
  /^(?:e-?books?|kindle|electronic|digital)(?:\s+(?:edition|version|download|format))?(?=\b|\d)/i;
const SEPARATOR = /^[\s.,:;()[\]{}/–—-]*(?:(?:and|or)\s+)?/i;
// Boundary whitespace has no lexical meaning. All token gates use the same
// trimmed tail, including numbered edition/designator payloads.
const CLAUSE_END = /^(?:$|[.,;:()[\]{}/]|[-–—]\s+|(?:and|or)\b)/i;
const NUMBERED_FORMAT = /^(?:(?:GN|vol(?:ume)?s?\.?|book|part)\s*)?#?\d+(?:\.\d+)?(?!\w)/i;
const LIST_CONTINUATION = /^(?:[-–—&,/+]|(?:and|or|to|through)\b)/i;
const MARKED_CONTENT = new RegExp(
  `(?:\\b${CONTENTS}?${MARKER}|#)\\s*#?${LABEL}(?!\\w|\\.\\d)`,
  "gi",
);

/** Read only a marked statement; its consumed prefix cannot certify its tail. */
function volumeStatement(text: string) {
  const volume = VOLUME.exec(text);
  if (!volume) return null;
  const stated = [volumeLabel(volume[2]!)];
  let consumed = volume[0].length;
  let range = false;
  let item = LIST_ITEM.exec(text.slice(consumed));
  while (item) {
    range ||= /^\s*(?:[-–—]|(?:to|through)\b)/i.test(item[0]);
    stated.push(volumeLabel(item[1]!));
    consumed += item[0].length;
    item = LIST_ITEM.exec(text.slice(consumed));
  }
  return {
    stated,
    consumed,
    range,
    list: volume[1] !== undefined || /^(?:vol(?:ume)?s\.?)/i.test(volume[0]) || stated.length > 1,
  };
}

/** The same lexical completion rule applies to Binding and Digital. */
function formatStatement(text: string) {
  const binding = BINDING_CLAUSE.exec(text);
  const token = binding ?? DIGITAL_CLAUSE.exec(text);
  if (!token) return null;
  const tail = text.slice(token[0].length);
  const next = tail.replace(SEPARATOR, "");
  if (
    !CLAUSE_END.test(tail.trimStart()) &&
    !NUMBERED_FORMAT.test(next) &&
    !EXPLICIT_VOLUME.test(next) &&
    !BINDING_CLAUSE.test(next) &&
    !DIGITAL_CLAUSE.test(next)
  )
    return null;
  // A marked Volume remains an independent content fact. Bare numbers and
  // ANN GN payloads can describe the format without certifying any Volume.
  const payload = VOLUME.test(next) ? null : NUMBERED_FORMAT.exec(next);
  return { binding, next: payload ? next.slice(payload[0].length).replace(SEPARATOR, "") : next };
}

function technicalStart(text: string) {
  return EXPLICIT_VOLUME.test(text) || formatStatement(text) !== null;
}

/**
 * Collect each explicit clause, rather than letting the first designation
 * mask later contents. Clause starts are field start, punctuation/wrappers,
 * and another technical statement immediately after a Volume or format.
 * Unknown prose outside a contents clause stays prose. An incomplete explicit
 * contents list is uncertainty, not silence. This is not a work-title grammar.
 */
export function bookFacts(value: unknown, names: readonly string[] = []) {
  const labels: string[] = [];
  const bindings: KnownBinding[] = [];
  const packaging: string[] = [];
  const unreadable: string[] = [];
  let digital = false;
  if (typeof value !== "string") return { labels, bindings, packaging, unreadable, digital };
  const keepVolume = (statement: NonNullable<ReturnType<typeof volumeStatement>>, text: string) => {
    if (statement.range || new Set(statement.stated).size > 1)
      packaging.push(text.slice(0, statement.consumed));
    else labels.push(...statement.stated);
  };
  const keepMarkedContents = (tail: string) => {
    const continuation = tail.split(/[;:()[\]{}]|\.(?=\s|$)/, 1)[0]!;
    for (const marker of continuation.matchAll(MARKED_CONTENT)) {
      const marked = continuation.slice(marker.index);
      const statement = volumeStatement(marked);
      if (statement) keepVolume(statement, marked);
    }
  };
  const text = outsideWork(decodeEntities(value), names);
  let consumedThrough = 0;
  const starts = Array.from(
    text.matchAll(/^|[,;:()[\]{}]|\.(?=\s|$)|\s[-–—]\s/g),
    (m) => m.index + m[0].length,
  );
  for (const start of starts) {
    if (start < consumedThrough) continue;
    let rest = text.slice(start).replace(SEPARATOR, "");
    // Each iteration consumes a nonempty statement, so even malformed input
    // cannot loop. Lists are read before commas become separate clauses.
    while (rest !== "") {
      const volume = volumeStatement(rest);
      if (volume) {
        keepVolume(volume, rest);
        const tail = rest.slice(volume.consumed);
        // Closing a wrapper cannot erase a following list connector. The
        // next component may itself be wrapped or may remain unresolved.
        const boundary = tail.trimStart().replace(/^[)\]}\s]+/, "");
        const next = tail.replace(SEPARATOR, "");
        // A list connector commits the contents clause to another component.
        // Never discard an unresolved component as display prose. A clearly
        // marked next statement can instead begin a new technical clause.
        const incompleteList =
          volume.list &&
          !technicalStart(next) &&
          (LIST_CONTINUATION.test(boundary) || !CLAUSE_END.test(boundary));
        if (
          incompleteList ||
          /^\s*(?:[-–—&/]\s*(?:\d|\?|$)|,\s*\d|\b(?:and|to|through)\s+\d|\+)/i.test(tail)
        ) {
          unreadable.push(`the Volume statement "${rest}" has unreadable contents`);
          // Preserve later marked facts inside this incomplete contents clause,
          // even when an unreadable additive component precedes them. Ordinary
          // prose in a separate clause remains outside this scoped scan.
          keepMarkedContents(tail);
        }
        rest = next;
        consumedThrough = text.length - rest.length;
        continue;
      }
      if (EXPLICIT_VOLUME.test(rest)) {
        unreadable.push(`the explicit Volume statement "${rest}" cannot be read`);
        keepMarkedContents(rest);
        break;
      }
      // "Digital adventures" and "Hardcover dreams" stay prose. Explicit
      // wrappers, clause boundaries and numbered format payloads retain facts.
      const format = formatStatement(rest);
      if (format) {
        if (format.binding) bindings.push(...bindingFacts(format.binding[0]));
        else digital = true;
        rest = format.next;
        consumedThrough = text.length - rest.length;
        continue;
      }
      const clause = rest.split(/[,;:()[\]{}]|\.(?=\s|$)|\s[-–—]\s/, 1)[0]!;
      const parsed = parseBookTitle(`Book, ${clause}`);
      if (parsed.packaging !== null || parsed.isBox) packaging.push(clause);
      break;
    }
  }
  return { labels, bindings, packaging, unreadable, digital };
}
