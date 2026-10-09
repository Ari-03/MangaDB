// The direct-edit field registry (spec §5): which fields of each
// canonical record type the proposal write path accepts, how each is edited,
// and how a submitted value is validated and normalized. Plain data + pure
// functions so the edit-form route renders inputs from the same descriptors
// the mutation validates against — the whitelist can never drift from the UI.
//
// Deliberately absent:
// - identity/structure (seriesId, editionId, position, coverage, format):
//   per CONTEXT.md a change to Release identity characteristics is a
//   different Release, and structural moves are their own operations, not
//   field edits. Format stays fixed for the same reason (and because Binding
//   only applies to physical Releases).
// - the canonical envelope (status, locked, overriddenFields): maintained by
//   the machinery itself, never edited as a field.

import type { Infer } from "convex/values";
import type { recordType } from "../schema";
import { partialDateSort, type DateParts } from "./dates";

export type RecordType = Infer<typeof recordType>;

export type FieldKind =
  | "text"
  | "textarea"
  | "stringList"
  | "select"
  | "partialDate"
  | "price"
  | "isbn13"
  | "isbn10"
  | "image";

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
   * Editorial prose (descriptions, synopses) or art rather than a
   * checkable fact. Factual changes need source evidence at proposal
   * submission (spec §5); editorial fields do not, and a Human Override on
   * one never stops matching (`factualOverrides`).
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

/**
 * A Release's or Bundle's stored cover art (lib/coverUploads.ts checks the
 * blob itself). Every person's change to it is a Human Override, since the
 * importer attaches art without a Revision to learn authorship from.
 */
const coverImage: FieldDescriptor = {
  name: "coverImage",
  label: "Cover",
  kind: "image",
  editorial: true,
  help: "A JPEG, PNG or WebP jacket. Removing it shows the ISBN jacket or the cloth placeholder.",
};

export const SOURCE_STATUS_OPTIONS = ["ongoing", "completed", "hiatus", "cancelled"] as const;

export const EDITABLE_FIELDS: Record<RecordType, FieldDescriptor[]> = {
  publisher: [
    text("name", "Name", { required: true }),
    textarea("description", "Description", { editorial: true }),
    {
      name: "contentRating",
      label: "Content rating",
      kind: "select",
      options: ["mature"],
      help: '"mature" when every book it issues is for adults (FAKKU, 801 Media, Ghost Ship): all its Series become Mature Series at the next library rebuild.',
    },
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
    textarea("synopsis", "Series synopsis", { editorial: true }),
    {
      name: "contentRating",
      label: "Content rating",
      kind: "select",
      options: ["mature", "general"],
      help: 'Leave empty to follow the publishers\' own age ratings. "mature" or "general" overrides them.',
    },
  ],
  volume: [
    text("label", "Volume label", {
      help: 'Publisher-facing designation ("7.5", "Side Story"). Clear for an unnumbered volume. Never the sort order.',
    }),
    textarea("synopsis", "Volume synopsis", { editorial: true }),
  ],
  editionLine: [text("name", "Line name", { required: true })],
  edition: [
    text("linePosition", "Edition line position", {
      help: 'Label within the edition line ("Omnibus 1"), independent of covered volumes.',
    }),
  ],
  release: [
    text("binding", "Binding", {
      help: "Physical releases only (paperback, hardcover…).",
    }),
    text("language", "Language", {
      required: true,
      help: 'ISO 639-1 code, e.g. "en".',
    }),
    { name: "isbn13", label: "ISBN-13", kind: "isbn13" },
    { name: "isbn10", label: "ISBN-10", kind: "isbn10" },
    { name: "pubDate", label: "Publication date", kind: "partialDate" },
    { name: "price", label: "Price", kind: "price" },
    textarea("description", "Release description", { editorial: true }),
    coverImage,
  ],
  releaseVariant: [text("name", "Variant name", { required: true })],
  releaseBundle: [
    text("name", "Bundle name", { required: true }),
    { name: "isbn13", label: "ISBN-13", kind: "isbn13" },
    { name: "isbn10", label: "ISBN-10", kind: "isbn10" },
    { name: "pubDate", label: "Publication date", kind: "partialDate" },
    { name: "price", label: "Price", kind: "price" },
    textarea("description", "Description", { editorial: true }),
    coverImage,
  ],
};

export function fieldDescriptor(type: RecordType, field: string): FieldDescriptor | null {
  return EDITABLE_FIELDS[type].find((d) => d.name === field) ?? null;
}

/**
 * The one editorial text field of a record type (its description or
 * synopsis), whose source a change may cite; null when it has none.
 */
export function editorialField(type: RecordType): FieldDescriptor | null {
  return EDITABLE_FIELDS[type].find((d) => d.kind === "textarea" && d.editorial) ?? null;
}

/**
 * The record's Human Overrides on checkable facts (dates, ISBNs, titles…),
 * leaving out editorial prose: a moderator polishing an imported blurb has
 * not touched the record's identity, so matching need not stop for it.
 */
export function factualOverrides(type: RecordType, overriddenFields: string[]): string[] {
  return overriddenFields.filter((field) => !fieldDescriptor(type, field)?.editorial);
}

// ---------- value validation & normalization ----------

export type Normalized = { ok: true; value: unknown } | { ok: false; message: string };

const invalid = (message: string): Normalized => ({ ok: false, message });

function normalizeString(descriptor: FieldDescriptor, raw: unknown): Normalized {
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
  const date: DateParts = {
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
  if (typeof amountCents !== "number" || !Number.isInteger(amountCents) || amountCents < 0) {
    return invalid("Price must be a whole number of cents.");
  }
  if (typeof currency !== "string" || !/^[A-Za-z]{3}$/.test(currency)) {
    return invalid("Currency must be a three-letter code.");
  }
  return { ok: true, value: { amountCents, currency: currency.toUpperCase() } };
}

// ---------- covers ----------

/** The file types a person may upload as cover art: what the shelf can show. */
export const COVER_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
/** The largest cover file accepted. */
export const MAX_COVER_UPLOAD_BYTES = 10 * 1024 * 1024;
/** The narrowest jacket worth shelving; the browser checks it, having decoded the file. */
export const MIN_COVER_WIDTH = 300;

export type CoverValue = { storageId: string; sourceUrl?: string; attribution?: string };

/**
 * A submitted cover: `{ storageId, attribution? }`, or null/undefined to
 * remove the stored art. `attribution` is where the art came from in a
 * person's words; when it is an https URL it is kept as `sourceUrl` too, as
 * the importer records it. Whether the blob exists and may be used is
 * checked against storage (lib/coverUploads.ts).
 */
function normalizeImage(raw: unknown): Normalized {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== "object") return invalid("Malformed cover.");
  const { storageId, attribution } = raw as Record<string, unknown>;
  if (typeof storageId !== "string" || storageId === "") {
    return invalid("A cover needs an uploaded file.");
  }
  if (attribution !== undefined && typeof attribution !== "string") {
    return invalid("A cover's source must be text.");
  }
  const source = attribution?.trim() ?? "";
  if (source.length > 500) return invalid("A cover's source is at most 500 characters.");
  const value: CoverValue = { storageId };
  if (source !== "") {
    value.attribution = source;
    if (httpsUrl(source)) value.sourceUrl = source;
  }
  return { ok: true, value };
}

// ---------- citations ----------

export type Citation = { sourceName: string; url: string };

/** Whether `raw` is an absolute https URL. */
export function httpsUrl(raw: string): boolean {
  try {
    return new URL(raw).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Validate the source a person cites for editorial text: a name and the
 * https page the text came from. Null stays null (no external source).
 */
export function normalizeCitation(
  raw: Citation | null,
): { ok: true; value: Citation | null } | { ok: false; message: string } {
  if (raw === null) return { ok: true, value: null };
  const sourceName = raw.sourceName.trim();
  const url = raw.url.trim();
  if (sourceName === "") return { ok: false, message: "Name the source of the text." };
  if (sourceName.length > 200) {
    return { ok: false, message: "A source name is at most 200 characters." };
  }
  if (!httpsUrl(url) || url.length > 2000) {
    return { ok: false, message: "A source needs the https page the text came from." };
  }
  return { ok: true, value: { sourceName, url } };
}

/** The longest one-line text a person writes into a field, or into one entry of a list. */
export const MAX_TEXT_LENGTH = 500;
/** The longest prose a person writes into a field (a description or synopsis). */
export const MAX_TEXTAREA_LENGTH = 10_000;
/** The most entries a person writes into a list field. */
export const MAX_LIST_ENTRIES = 100;

/**
 * Why a normalized value is too long for a person to write into its field,
 * or null. Checked on the values a person changes (moderation.ts
 * validateUpdate), not while normalizing: an import's longer text, and a
 * value a record already holds, still pass.
 */
export function overLength(descriptor: FieldDescriptor, value: unknown): string | null {
  const max = descriptor.kind === "textarea" ? MAX_TEXTAREA_LENGTH : MAX_TEXT_LENGTH;
  if (typeof value === "string" && value.length > max) {
    return `${descriptor.label} is at most ${max} characters.`;
  }
  if (!Array.isArray(value)) return null;
  if (value.length > MAX_LIST_ENTRIES) {
    return `${descriptor.label} holds at most ${MAX_LIST_ENTRIES} entries.`;
  }
  if (value.some((item) => typeof item === "string" && item.length > MAX_TEXT_LENGTH)) {
    return `Each entry of ${descriptor.label} is at most ${MAX_TEXT_LENGTH} characters.`;
  }
  return null;
}

/**
 * Validate and normalize one submitted field value against its descriptor.
 * `undefined` (or an empty string/list) clears an optional field.
 */
export function normalizeFieldValue(descriptor: FieldDescriptor, raw: unknown): Normalized {
  switch (descriptor.kind) {
    case "text":
    case "textarea":
      return normalizeString(descriptor, raw);
    case "select": {
      const asString = normalizeString(descriptor, raw);
      if (!asString.ok || asString.value === undefined) return asString;
      if (!(descriptor.options ?? []).includes(asString.value as string)) {
        return invalid(
          `${descriptor.label} must be one of: ${(descriptor.options ?? []).join(", ")}.`,
        );
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
    case "image":
      return normalizeImage(raw);
  }
}
