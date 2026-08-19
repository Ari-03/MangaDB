// The direct-edit field registry (ticket #31, spec §5): which fields of each
// canonical record type the proposal write path accepts, how each is edited,
// and how a submitted value is validated and normalized. Plain data + pure
// functions so the edit-form route renders inputs from the same descriptors
// the mutation validates against — the whitelist can never drift from the UI.
//
// Deliberately absent:
// - identity/structure (seriesId, editionId, position, coverage, format):
//   per CONTEXT.md a change to Release identity characteristics is a
//   different Release, and structural moves are their own proposal ops in a
//   later slice. Format stays fixed for the same reason (and because Binding
//   only applies to physical Releases).
// - the canonical envelope (status, locked, overriddenFields): maintained by
//   the machinery itself, never edited as a field.

export type RecordType =
  | "publisher"
  | "seriesFamily"
  | "series"
  | "volume"
  | "editionLine"
  | "edition"
  | "release"
  | "releaseVariant"
  | "releaseBundle";

export type FieldKind =
  | "text"
  | "textarea"
  | "stringList"
  | "select"
  | "partialDate"
  | "price"
  | "isbn13"
  | "isbn10";

export type FieldDescriptor = {
  name: string;
  label: string;
  kind: FieldKind;
  /** Required fields reject an empty value; others clear to absent. */
  required?: boolean;
  /** For kind "select": the allowed values ("" clears when not required). */
  options?: readonly string[];
  help?: string;
  /**
   * Editorial prose (descriptions, synopses) rather than a checkable fact.
   * Factual changes need source evidence at proposal submission (spec §5);
   * editorial fields do not.
   */
  editorial?: boolean;
};

const text = (
  name: string,
  label: string,
  extra: Partial<FieldDescriptor> = {},
): FieldDescriptor => ({ name, label, kind: "text", ...extra });

const textarea = (
  name: string,
  label: string,
  extra: Partial<FieldDescriptor> = {},
): FieldDescriptor => ({ name, label, kind: "textarea", ...extra });

export const SOURCE_STATUS_OPTIONS = [
  "ongoing",
  "completed",
  "hiatus",
  "cancelled",
] as const;

export const EDITABLE_FIELDS: Record<RecordType, FieldDescriptor[]> = {
  publisher: [
    text("name", "Name", { required: true }),
    textarea("description", "Description", { editorial: true }),
  ],
  seriesFamily: [text("name", "Name", { required: true })],
  series: [
    text("title", "Title", { required: true }),
    {
      name: "altTitles",
      label: "Alternative titles",
      kind: "stringList",
      help: "One per line.",
    },
    {
      name: "sourceStatus",
      label: "Source status",
      kind: "select",
      options: SOURCE_STATUS_OPTIONS,
      help: "The source work's completion state, not the English edition's.",
    },
  ],
  volume: [
    text("label", "Volume label", {
      help: "Publisher-facing designation (\"7.5\", \"Side Story\"). Clear for an unnumbered volume. Never the sort order.",
    }),
    textarea("synopsis", "Volume synopsis", { editorial: true }),
  ],
  editionLine: [text("name", "Line name", { required: true })],
  edition: [
    text("linePosition", "Edition line position", {
      help: "Label within the edition line (\"Omnibus 1\"), independent of covered volumes.",
    }),
  ],
  release: [
    text("binding", "Binding", {
      help: "Physical releases only (paperback, hardcover…).",
    }),
    text("language", "Language", {
      required: true,
      help: "ISO 639-1 code, e.g. \"en\".",
    }),
    { name: "isbn13", label: "ISBN-13", kind: "isbn13" },
    { name: "isbn10", label: "ISBN-10", kind: "isbn10" },
    { name: "pubDate", label: "Publication date", kind: "partialDate" },
    { name: "price", label: "Price", kind: "price" },
    textarea("description", "Release description", { editorial: true }),
  ],
  releaseVariant: [text("name", "Variant name", { required: true })],
  releaseBundle: [
    text("name", "Bundle name", { required: true }),
    { name: "isbn13", label: "ISBN-13", kind: "isbn13" },
    { name: "isbn10", label: "ISBN-10", kind: "isbn10" },
    { name: "pubDate", label: "Publication date", kind: "partialDate" },
    { name: "price", label: "Price", kind: "price" },
    textarea("description", "Description", { editorial: true }),
  ],
};

export function fieldDescriptor(
  type: RecordType,
  field: string,
): FieldDescriptor | null {
  return EDITABLE_FIELDS[type].find((d) => d.name === field) ?? null;
}

// ---------- value validation & normalization ----------

export type Normalized =
  | { ok: true; value: unknown }
  | { ok: false; message: string };

const invalid = (message: string): Normalized => ({ ok: false, message });

/** Partial-precision date as submitted by the form (sort key added here). */
export type PartialDateInput = { year: number; month?: number; day?: number };

/** The yyyymmdd sort key with zeroed unknown parts (spec §8). */
export function partialDateSort(date: PartialDateInput): number {
  return date.year * 10000 + (date.month ?? 0) * 100 + (date.day ?? 0);
}

function normalizeString(
  descriptor: FieldDescriptor,
  raw: unknown,
): Normalized {
  if (raw === undefined || raw === null) {
    return descriptor.required
      ? invalid(`${descriptor.label} is required.`)
      : { ok: true, value: undefined };
  }
  if (typeof raw !== "string") return invalid(`${descriptor.label} must be text.`);
  const trimmed = raw.trim();
  if (trimmed === "") {
    return descriptor.required
      ? invalid(`${descriptor.label} is required.`)
      : { ok: true, value: undefined };
  }
  return { ok: true, value: trimmed };
}

function normalizeIsbn(digits: 10 | 13, raw: unknown): Normalized {
  if (raw === undefined || raw === null || raw === "") {
    return { ok: true, value: undefined };
  }
  if (typeof raw !== "string") return invalid("ISBN must be text.");
  const compact = raw.replace(/[\s-]/g, "").toUpperCase();
  if (compact === "") return { ok: true, value: undefined };
  const pattern = digits === 13 ? /^[0-9]{13}$/ : /^[0-9]{9}[0-9X]$/;
  if (!pattern.test(compact)) {
    return invalid(`Not a well-formed ISBN-${digits}.`);
  }
  return { ok: true, value: compact };
}

function normalizePartialDate(raw: unknown): Normalized {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== "object") return invalid("Malformed date.");
  const { year, month, day } = raw as Record<string, unknown>;
  if (typeof year !== "number" || !Number.isInteger(year) || year < 1900 || year > 2200) {
    return invalid("Date needs a plausible four-digit year.");
  }
  if (month !== undefined) {
    if (typeof month !== "number" || !Number.isInteger(month) || month < 1 || month > 12) {
      return invalid("Month must be 1–12.");
    }
  }
  if (day !== undefined) {
    if (month === undefined) return invalid("A day needs a month.");
    if (typeof day !== "number" || !Number.isInteger(day) || day < 1 || day > 31) {
      return invalid("Day must be 1–31.");
    }
  }
  const date: PartialDateInput = {
    year,
    ...(month !== undefined ? { month: month as number } : {}),
    ...(day !== undefined ? { day: day as number } : {}),
  };
  return { ok: true, value: { ...date, sort: partialDateSort(date) } };
}

function normalizePrice(raw: unknown): Normalized {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== "object") return invalid("Malformed price.");
  const { amountCents, currency } = raw as Record<string, unknown>;
  if (
    typeof amountCents !== "number" ||
    !Number.isInteger(amountCents) ||
    amountCents < 0
  ) {
    return invalid("Price must be a whole number of cents.");
  }
  if (typeof currency !== "string" || !/^[A-Za-z]{3}$/.test(currency)) {
    return invalid("Currency must be a three-letter code.");
  }
  return { ok: true, value: { amountCents, currency: currency.toUpperCase() } };
}

/**
 * Validate and normalize one submitted field value against its descriptor.
 * `undefined` (or an empty string/list) clears an optional field.
 */
export function normalizeFieldValue(
  descriptor: FieldDescriptor,
  raw: unknown,
): Normalized {
  switch (descriptor.kind) {
    case "text":
    case "textarea":
      return normalizeString(descriptor, raw);
    case "select": {
      const asString = normalizeString(descriptor, raw);
      if (!asString.ok || asString.value === undefined) return asString;
      if (!(descriptor.options ?? []).includes(asString.value as string)) {
        return invalid(`${descriptor.label} must be one of: ${(descriptor.options ?? []).join(", ")}.`);
      }
      return asString;
    }
    case "stringList": {
      if (raw === undefined || raw === null) return { ok: true, value: [] };
      if (!Array.isArray(raw) || raw.some((item) => typeof item !== "string")) {
        return invalid(`${descriptor.label} must be a list of text entries.`);
      }
      const items = raw.map((item) => item.trim()).filter((item) => item !== "");
      return { ok: true, value: items };
    }
    case "isbn13":
      return normalizeIsbn(13, raw);
    case "isbn10":
      return normalizeIsbn(10, raw);
    case "partialDate":
      return normalizePartialDate(raw);
    case "price":
      return normalizePrice(raw);
  }
}
