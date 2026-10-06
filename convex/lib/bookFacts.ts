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
  /^(?:(?:trade|mature)\s+)?(hard\s?(?:cover|back|bound)|paper\s?back|soft\s?(?:cover|back|bound))(?:\s*(?:edition|version|binding|format))?(?=\b|\d)/i;
const DIGITAL_CLAUSE =
  /^(?:e-?books?|kindle|electronic|digital)(?:\s*(?:edition|version|download|format))?(?=\b|\d)/i;
const SEPARATOR = /^[\s.,:;()[\]{}/–—-]*(?:(?:and|or)\s+)?/i;
// Boundary whitespace has no lexical meaning. All token gates use the same
// trimmed tail, including numbered edition/designator payloads.
const CLAUSE_END = /^(?:$|[.,;:()[\]{}/]|[-–—]\s+|(?:and|or)\b)/i;
// Format numbers are designators, not contents. Explicit technical markers
// retain format even when their payload is unreadable; narrative words do not.
const FORMAT_NUMBER = /^(?:\d+(?:\.\d+)?|[IVXLCDM]+)(?!\w)/i;
const FORMAT_DESIGNATOR = /^(?:GN|#)+\s*/i;
const CONTENT_LABEL = new RegExp(`^#?(${LABEL})(?!\\w|\\.\\d)`, "i");

/** Independent technical statements cannot be the preceding format's payload. */
function technicalStatement(text: string) {
  return (
    (!text.startsWith("#") && (VOLUME.test(text) || EXPLICIT_VOLUME.test(text))) ||
    BINDING_CLAUSE.test(text) ||
    DIGITAL_CLAUSE.test(text)
  );
}

function formatDesignator(text: string) {
  const match = FORMAT_DESIGNATOR.exec(text);
  if (!match) return null;
  const after = text.slice(match[0].length);
  // GN may adjoin a technical statement or another designator, but an
  // arbitrary word beginning with GN is still prose.
  if (
    /^GN/i.test(match[0]) &&
    /^\w/.test(after) &&
    /GN$/i.test(match[0]) &&
    !technicalStatement(after) &&
    !FORMAT_NUMBER.test(after)
  )
    return null;
  return match;
}

/** Unknown designator text ends before a later independent technical statement. */
function unknownFormatPayload(text: string) {
  const clause = text.split(/[,;:()[\]{}]|\.(?=\s|$)/, 1)[0]!;
  for (const boundary of clause.matchAll(/\s+(?=\S)/g)) {
    const start = boundary.index + boundary[0].length;
    const next = clause.slice(start);
    if (
      (!next.startsWith("#") && (VOLUME.test(next) || EXPLICIT_VOLUME.test(next))) ||
      formatPrefix(next)
    )
      return start;
  }
  return clause.length;
}

/** Track annotation nesting so punctuation inside it cannot end contents scope. */
function wrapperDepth(text: string, depth: number) {
  for (const char of text) {
    if (/[([{]/.test(char)) depth++;
    else if (/[)\]}]/.test(char)) depth = Math.max(0, depth - 1);
  }
  return depth;
}

/** Read boundaries before discarding them, preserving connected contents scope. */
function clauseBoundary(text: string, depth = 0) {
  let next = text;
  let connected = false;
  let range = false;
  let separate = false;
  while (next !== "") {
    const wrappers = /^[\s()[\]{}]+/.exec(next);
    if (wrappers) {
      depth = wrapperDepth(wrappers[0], depth);
      next = next.slice(wrappers[0].length);
      continue;
    }
    const end = /^(?:[;:]|\.(?=\s|$))/.exec(next);
    if (end) {
      separate ||= depth === 0;
      if (separate) connected = false;
      next = next.slice(end[0].length);
      continue;
    }
    const connector = /^(?:[-–—&,/+]|(?:and|or|to|through)\b)\s*/i.exec(next);
    if (!connector) break;
    connected ||= !separate;
    range ||= !separate && /^(?:[-–—]|to\b|through\b)/i.test(connector[0]);
    next = next.slice(connector[0].length);
  }
  return { next, connected, range, separate, depth };
}
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
function formatPrefix(text: string) {
  const binding = BINDING_CLAUSE.exec(text);
  const token = binding ?? DIGITAL_CLAUSE.exec(text);
  if (!token) return null;
  const tail = text.slice(token[0].length);
  // Only opening annotation wrappers can introduce this token's payload.
  // A number after a closing wrapper or list connector belongs to the list.
  const prefix = /^[\s([{]*/.exec(tail)![0].length;
  const next = tail.slice(prefix);
  const designator = formatDesignator(next);
  const number = FORMAT_NUMBER.exec(next);
  if (!CLAUSE_END.test(tail.trimStart()) && !number && !designator && !technicalStatement(next))
    return null;
  return { binding, tail, prefix, next, designator, number };
}

function formatStatement(text: string) {
  const token = formatPrefix(text);
  if (!token) return null;
  const { binding, tail, prefix, next, designator, number } = token;
  // A marked Volume remains independent contents evidence. Bare Roman or
  // Arabic format numbers never establish canonical Volume coverage.
  let payload = 0;
  if (!technicalStatement(next)) {
    if (designator) {
      let after = next;
      let marker: ReturnType<typeof formatDesignator> = designator;
      while (marker) {
        payload += marker[0].length;
        after = next.slice(payload);
        const opening = /^[\s([{]*/.exec(after)![0];
        payload += opening.length;
        after = next.slice(payload);
        marker = !technicalStatement(after) ? formatDesignator(after) : null;
      }
      if (!technicalStatement(after))
        payload += FORMAT_NUMBER.exec(after)?.[0].length ?? unknownFormatPayload(after);
    } else payload = number?.[0].length ?? 0;
  }
  return { binding, tail: payload ? tail.slice(prefix + payload) : tail };
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
    let depth = wrapperDepth(text.slice(0, text.length - rest.length), 0);
    let contentsScope = false;
    let volumeContext = false;
    let expectedComponent = false;
    let rangeComponent = false;
    const advance = (tail: string, scope: boolean) => {
      depth = wrapperDepth(rest.slice(0, rest.length - tail.length), depth);
      const boundary = clauseBoundary(tail, depth);
      depth = boundary.depth;
      contentsScope = scope && !boundary.separate;
      volumeContext &&= !boundary.separate;
      // Remember a singular Volume through format annotations. A connector
      // creates a component expectation using the same grammar as any list.
      expectedComponent = volumeContext && boundary.connected;
      contentsScope ||= expectedComponent;
      rangeComponent = expectedComponent && boundary.range;
      rest = boundary.next;
      consumedThrough = text.length - rest.length;
      if (expectedComponent && rest === "")
        unreadable.push(`the Volume statement "${tail}" has unreadable contents`);
    };
    // Each iteration consumes a nonempty statement. Contents provenance stays
    // active across wrappers and format annotations until a separate clause.
    while (rest !== "") {
      const volume = volumeStatement(rest);
      if (volume) {
        keepVolume(volume, rest);
        if (rangeComponent) packaging.push(rest.slice(0, volume.consumed));
        const tail = rest.slice(volume.consumed);
        volumeContext = true;
        advance(tail, contentsScope || volume.list);
        continue;
      }
      const component = expectedComponent ? CONTENT_LABEL.exec(rest) : null;
      if (component) {
        labels.push(volumeLabel(component[1]!));
        if (rangeComponent) packaging.push(component[0]);
        advance(rest.slice(component[0].length), true);
        continue;
      }
      if (EXPLICIT_VOLUME.test(rest)) {
        unreadable.push(`the explicit Volume statement "${rest}" cannot be read`);
        keepMarkedContents(rest);
        break;
      }
      // Format annotations do not settle an explicit contents statement.
      // "Digital adventures" and "Hardcover dreams" remain display prose.
      const format = formatStatement(rest);
      if (format) {
        if (format.binding) bindings.push(...bindingFacts(format.binding[1]));
        else digital = true;
        advance(format.tail, contentsScope);
        continue;
      }
      if (contentsScope) {
        unreadable.push(`the Volume statement "${rest}" has unreadable contents`);
        keepMarkedContents(rest);
      }
      const clause = rest.split(/[,;:()[\]{}]|\.(?=\s|$)|\s[-–—]\s/, 1)[0]!;
      const parsed = parseBookTitle(`Book, ${clause}`);
      if (parsed.packaging !== null || parsed.isBox) packaging.push(clause);
      break;
    }
  }
  return { labels, bindings, packaging, unreadable, digital };
}
