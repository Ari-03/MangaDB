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
  /^(?:(?:trade|mature)\s+)?(?:hard\s?(?:cover|back|bound)|paper\s?back|soft\s?(?:cover|back|bound))(?:\s+(?:edition|version|binding|format))?\b/i;
const DIGITAL_CLAUSE =
  /^(?:e-?books?|kindle|electronic|digital)(?:\s+(?:edition|version|download|format))?\b/i;
const SEPARATOR = /^[\s.,:;()[\]{}/–—-]*(?:(?:and|or)\s+)?/i;
const CLAUSE_END = /^(?:$|[.,;:()[\]{}/]|\s+[-–—]\s+|\s+(?:and|or)\b)/i;

/**
 * Collect each explicit clause, rather than letting the first designation
 * mask later contents. Clause starts are field start, punctuation/wrappers,
 * and another technical statement immediately after a Volume or format.
 * Unknown prose after a statement stays prose; an explicit unreadable Volume
 * statement is uncertainty, not silence. This is not a work-title grammar.
 */
export function bookFacts(value: unknown, names: readonly string[] = []) {
  const labels: string[] = [];
  const bindings: KnownBinding[] = [];
  const packaging: string[] = [];
  const unreadable: string[] = [];
  let digital = false;
  if (typeof value !== "string") return { labels, bindings, packaging, unreadable, digital };
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
      const offset = text.length - rest.length;
      const volume = VOLUME.exec(rest);
      if (volume) {
        const stated = [volumeLabel(volume[2]!)];
        let consumed = volume[0].length;
        let item = LIST_ITEM.exec(rest.slice(consumed));
        while (item) {
          stated.push(volumeLabel(item[1]!));
          consumed += item[0].length;
          item = LIST_ITEM.exec(rest.slice(consumed));
        }
        if (new Set(stated).size > 1) packaging.push(rest.slice(0, consumed));
        else labels.push(...stated);
        const tail = rest.slice(consumed);
        if (/^\s*(?:[-–—&/]\s*(?:\d|\?|$)|,\s*\d|\b(?:and|to|through)\s+\d|\+)/i.test(tail)) {
          unreadable.push(`the Volume statement "${rest}" has unreadable contents`);
        }
        rest = tail.replace(SEPARATOR, "");
        consumedThrough = text.length - rest.length;
        continue;
      }
      if (EXPLICIT_VOLUME.test(rest)) {
        unreadable.push(`the explicit Volume statement "${rest}" cannot be read`);
        break;
      }
      const binding = BINDING_CLAUSE.exec(rest);
      const format = DIGITAL_CLAUSE.exec(rest);
      const token = binding ?? format;
      if (token) {
        const tail = rest.slice(token[0].length);
        const next = tail.replace(SEPARATOR, "");
        // "Digital adventures" and "Hardcover dreams" are prose, while
        // "Hardcover / Paperback" and "Digital, Vol. 1" state known facts.
        if (
          CLAUSE_END.test(tail) ||
          VOLUME.test(next) ||
          BINDING_CLAUSE.test(next) ||
          DIGITAL_CLAUSE.test(next)
        ) {
          if (binding) bindings.push(...bindingFacts(binding[0]));
          else digital = true;
          rest = next;
          consumedThrough = offset + token[0].length + tail.length - next.length;
          continue;
        }
      }
      const clause = rest.split(/[,;:()[\]{}]|\.(?=\s|$)|\s[-–—]\s/, 1)[0]!;
      const parsed = parseBookTitle(`Book, ${clause}`);
      if (parsed.packaging !== null || parsed.isBox) packaging.push(clause);
      break;
    }
  }
  return { labels, bindings, packaging, unreadable, digital };
}
