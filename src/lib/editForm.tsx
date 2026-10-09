// Shared form plumbing for the record edit surfaces: the Moderator direct
// edit (/mod/edit), the Editor update proposal (/mod/propose) and the
// reader's Suggestion (/suggest).
// Everything edits as strings keyed by field name; the submit handlers shape
// typed values that the Convex mutations re-validate against the same
// registry (convex/lib/moderationFields.ts). A cover is the JSON of its
// `CoverDraft` (empty for no art), and the source of a description lives
// beside it under `{field}.source…` keys (`draftCitation`).

import {
  EDITABLE_FIELDS,
  httpsUrl,
  normalizeCitation,
  type Citation,
  type FieldDescriptor,
  type RecordType,
} from "../../convex/lib/moderationFields";
import type { Id } from "../../convex/_generated/dataModel";

/**
 * Whether a `$type` route segment names an editable record type. Own keys
 * only: `in` would also accept "constructor" and "toString".
 */
export function isRecordType(raw: string): raw is RecordType {
  return Object.hasOwn(EDITABLE_FIELDS, raw);
}

export type FormState = Record<string, string>;

/** A cover as the form holds it: the blob and where the art came from, in the person's words. */
export type CoverDraft = { storageId: string; attribution: string };

/** The form-state string of a cover: its JSON, or "" for no stored art. */
export function encodeCover(cover: CoverDraft | null): string {
  return cover ? JSON.stringify(cover) : "";
}

/** The cover a form-state string holds (`encodeCover`), or null for none. */
export function decodeCover(raw: string | undefined): CoverDraft | null {
  if (!raw) return null;
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) return null;
  const { storageId, attribution } = parsed as Record<string, unknown>;
  return typeof storageId === "string"
    ? { storageId, attribution: typeof attribution === "string" ? attribution : "" }
    : null;
}

/** A stored cover value (convex schema `cover`) as the form holds it. */
function coverOf(value: unknown): CoverDraft | null {
  if (typeof value !== "object" || value === null) return null;
  const { storageId, attribution } = value as Record<string, unknown>;
  return typeof storageId === "string"
    ? { storageId, attribution: typeof attribution === "string" ? attribution : "" }
    : null;
}

export function initialFormState(fields: Array<FieldDescriptor & { value: unknown }>): FormState {
  const state: FormState = {};
  for (const field of fields) {
    const value = field.value;
    switch (field.kind) {
      case "stringList":
        state[field.name] = Array.isArray(value) ? value.join("\n") : "";
        break;
      case "partialDate": {
        const date = (value ?? {}) as { year?: number; month?: number; day?: number };
        state[`${field.name}.year`] = date.year !== undefined ? String(date.year) : "";
        state[`${field.name}.month`] = date.month !== undefined ? String(date.month) : "";
        state[`${field.name}.day`] = date.day !== undefined ? String(date.day) : "";
        break;
      }
      case "price": {
        const price = (value ?? {}) as { amountCents?: number; currency?: string };
        state[`${field.name}.amount`] =
          price.amountCents !== undefined ? (price.amountCents / 100).toFixed(2) : "";
        state[`${field.name}.currency`] = price.currency ?? "USD";
        break;
      }
      case "image":
        state[field.name] = encodeCover(coverOf(value));
        break;
      default:
        state[field.name] = typeof value === "string" ? value : "";
    }
  }
  return state;
}

/**
 * The submitted value for one field, from the raw form state. A cleared
 * date or price is `null`, not `undefined`: Convex drops undefined object
 * properties on the wire, and the mutations require every change's `value`.
 */
export function fieldValue(
  descriptor: FieldDescriptor,
  state: FormState,
): { ok: true; value: unknown } | { ok: false; message: string } {
  switch (descriptor.kind) {
    case "stringList":
      return {
        ok: true,
        value: (state[descriptor.name] ?? "")
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line !== ""),
      };
    case "partialDate": {
      const year = (state[`${descriptor.name}.year`] ?? "").trim();
      const month = (state[`${descriptor.name}.month`] ?? "").trim();
      const day = (state[`${descriptor.name}.day`] ?? "").trim();
      if (year === "") return { ok: true, value: null };
      const parsed: { year: number; month?: number; day?: number } = {
        year: Number(year),
      };
      if (month !== "") parsed.month = Number(month);
      if (day !== "") parsed.day = Number(day);
      if (
        [parsed.year, parsed.month, parsed.day].some((n) => n !== undefined && !Number.isInteger(n))
      ) {
        return {
          ok: false,
          message: `${descriptor.label}: year, month, and day must be whole numbers.`,
        };
      }
      return { ok: true, value: parsed };
    }
    case "price": {
      const amount = (state[`${descriptor.name}.amount`] ?? "").trim();
      if (amount === "") return { ok: true, value: null };
      const parsed = Number(amount);
      if (!Number.isFinite(parsed) || parsed < 0) {
        return { ok: false, message: `${descriptor.label}: malformed amount.` };
      }
      return {
        ok: true,
        value: {
          amountCents: Math.round(parsed * 100),
          currency: (state[`${descriptor.name}.currency`] ?? "USD").trim(),
        },
      };
    }
    case "image":
      return { ok: true, value: decodeCover(state[descriptor.name]) };
    default:
      return { ok: true, value: state[descriptor.name] ?? "" };
  }
}

/** Form-state keys backing one field (dirtiness is tracked per input). */
export function stateKeysOf(descriptor: FieldDescriptor): string[] {
  switch (descriptor.kind) {
    case "partialDate":
      return [`${descriptor.name}.year`, `${descriptor.name}.month`, `${descriptor.name}.day`];
    case "price":
      return [`${descriptor.name}.amount`, `${descriptor.name}.currency`];
    default:
      return [descriptor.name];
  }
}

/**
 * One edit session's local state: the form values, which inputs were
 * touched, and the base Revision those values were loaded from. The base is
 * snapshotted with the values so a save cannot pair a newer base with older
 * values and slip past the server's stale-revision check.
 */
export type EditDraft<Base> = {
  values: FormState;
  dirty: ReadonlySet<string>;
  baseRevisionId: Base;
};

/** An untouched draft of the live record (what the form shows before any edit). */
export function freshDraft<Base>(form: {
  fields: Array<FieldDescriptor & { value: unknown }>;
  baseRevisionId: Base;
}): EditDraft<Base> {
  return {
    values: initialFormState(form.fields),
    dirty: new Set(),
    baseRevisionId: form.baseRevisionId,
  };
}

/** The draft with one input changed; the base Revision stays pinned. */
export function editDraft<Base>(
  draft: EditDraft<Base>,
  key: string,
  value: string,
): EditDraft<Base> {
  return {
    ...draft,
    values: { ...draft.values, [key]: value },
    dirty: new Set([...draft.dirty, key]),
  };
}

/**
 * The draft with `keys` put back to `initial` and no longer touched: undoing
 * a choice (Keep current cover) must not leave a no-op change behind.
 */
export function revertDraft<Base>(
  draft: EditDraft<Base>,
  keys: ReadonlyArray<string>,
  initial: FormState,
): EditDraft<Base> {
  const values = { ...draft.values };
  for (const key of keys) values[key] = initial[key] ?? "";
  return { ...draft, values, dirty: new Set([...draft.dirty].filter((k) => !keys.includes(k))) };
}

/** Whether the record gained a Revision after this draft's values were loaded. */
export function draftIsStale<Base>(draft: EditDraft<Base>, liveBase: Base): boolean {
  return draft.baseRevisionId !== liveBase;
}

/** The field/value changes a draft submits: one per field with a touched input. */
export function draftChanges<Base>(
  fields: FieldDescriptor[],
  draft: EditDraft<Base>,
):
  | { ok: true; changes: Array<{ field: string; value: unknown }> }
  | { ok: false; message: string } {
  const changes: Array<{ field: string; value: unknown }> = [];
  for (const field of fields) {
    if (!stateKeysOf(field).some((k) => draft.dirty.has(k))) continue;
    const result = fieldValue(field, draft.values);
    if (!result.ok) return result;
    changes.push({ field: field.name, value: result.value });
  }
  return { ok: true, changes };
}

// ---------- the source of a description ----------

/**
 * Where a description's text comes from, as the form's source radios say:
 * keep the current credit, a source record's blurb ("Use this
 * description"), another page the person names, or no external source.
 */
export type SourceMode = "keep" | "observation" | "custom" | "none";

/** The form-state keys of `field`'s source choice. */
export function sourceKeys(field: string) {
  return {
    mode: `${field}.source`,
    name: `${field}.sourceName`,
    url: `${field}.sourceUrl`,
    observation: `${field}.observationId`,
  };
}

/** The radio a description's source starts on: Keep when it has a credit, else no external source. */
export function sourceMode(
  values: FormState,
  field: string,
  attribution: Citation | null,
): SourceMode {
  const chosen = values[sourceKeys(field).mode];
  if (chosen === "observation" || chosen === "custom" || chosen === "none") return chosen;
  return attribution ? "keep" : "none";
}

/**
 * The source statement a draft makes for the record's editorial `field`
 * (convex/moderation.ts validateUpdate): nothing (undefined) unless the
 * text or its source was touched; null for empty text or no external
 * source; else the citation, plus the source record as evidence when a
 * blurb was used. A named page needs a name and an https URL.
 */
export function draftCitation(
  field: FieldDescriptor | null,
  values: FormState,
  dirty: ReadonlySet<string>,
  attribution: Citation | null,
):
  | {
      ok: true;
      citation: Citation | null | undefined;
      evidence: Array<{ kind: "observation"; observationId: Id<"sourceObservations"> }>;
    }
  | { ok: false; message: string } {
  const none = { ok: true as const, citation: undefined, evidence: [] };
  if (!field) return none;
  const keys = sourceKeys(field.name);
  if (![field.name, ...Object.values(keys)].some((key) => dirty.has(key))) return none;
  if ((values[field.name] ?? "").trim() === "") return { ok: true, citation: null, evidence: [] };
  const named = (sourceName: string, url: string) => {
    const normalized = normalizeCitation({ sourceName, url });
    return normalized.ok
      ? normalized
      : {
          ok: false as const,
          message: "Add the page the text came from, or choose Original prose.",
        };
  };
  switch (sourceMode(values, field.name, attribution)) {
    case "keep":
      return { ok: true, citation: attribution, evidence: [] };
    case "none":
      return { ok: true, citation: null, evidence: [] };
    case "custom": {
      const result = named(values[keys.name] ?? "", values[keys.url] ?? "");
      return result.ok ? { ok: true, citation: result.value, evidence: [] } : result;
    }
    case "observation": {
      const result = named(values[keys.name] ?? "", values[keys.url] ?? "");
      if (!result.ok) return result;
      // Form state holds the id the sourceBlurbs query returned.
      const observationId = (values[keys.observation] ?? "") as Id<"sourceObservations">;
      return {
        ok: true,
        citation: result.value,
        evidence: observationId ? [{ kind: "observation", observationId }] : [],
      };
    }
  }
}

/**
 * The form state that resumes a saved Draft's update of a record: the
 * record's current values with the update's after-values over them, those
 * inputs touched, and the update's source statement for the record's text
 * set on the source radios (a blurb used from a source when the Draft's
 * evidence names its record, `observationId`, else the named page).
 */
export function resumedFormState(
  fields: Array<FieldDescriptor & { value: unknown }>,
  update: {
    changes: ReadonlyArray<{ field: string; after?: unknown }>;
    citation?: Citation | null;
  },
  observationId: string | null,
  attribution: Citation | null,
): { values: FormState; dirty: Set<string> } {
  const changed = new Map(update.changes.map((change) => [change.field, change.after]));
  const values = initialFormState(
    fields.map((field) =>
      changed.has(field.name) ? { ...field, value: changed.get(field.name) } : field,
    ),
  );
  const dirty = new Set(fields.filter((field) => changed.has(field.name)).flatMap(stateKeysOf));
  const text = fields.find((field) => field.kind === "textarea" && field.editorial);
  const { citation } = update;
  if (text && citation !== undefined) {
    const keys = sourceKeys(text.name);
    dirty.add(keys.mode);
    if (citation === null) {
      values[keys.mode] = "none";
    } else if (
      citation.sourceName === attribution?.sourceName &&
      citation.url === attribution.url
    ) {
      values[keys.mode] = "keep";
    } else {
      values[keys.mode] = observationId ? "observation" : "custom";
      values[keys.name] = citation.sourceName;
      values[keys.url] = citation.url;
      if (observationId) values[keys.observation] = observationId;
    }
  }
  return { values, dirty };
}

/** Whether a source record's page can be cited: an https URL. */
export const citableUrl = (url: string | null): url is string => url !== null && httpsUrl(url);

/**
 * The input(s) for one field. `disabled` locks them, e.g. while a save is in
 * flight, so nothing typed then can be discarded when the save resets the form.
 */
export function FieldInput({
  field,
  values,
  setValue,
  disabled = false,
}: {
  field: FieldDescriptor & { value: unknown };
  values: FormState;
  setValue: (key: string, value: string) => void;
  disabled?: boolean;
}) {
  switch (field.kind) {
    // Covers have their own section (lib/coverField.tsx).
    case "image":
      return null;
    case "textarea":
    case "stringList":
      return (
        <label>
          {field.label}
          <textarea
            value={values[field.name] ?? ""}
            disabled={disabled}
            onChange={(event) => setValue(field.name, event.target.value)}
            rows={field.kind === "stringList" ? 3 : 4}
          />
          {field.help ? <span className="field-help">{field.help}</span> : null}
        </label>
      );
    case "select":
      return (
        <label>
          {field.label}
          <select
            value={values[field.name] ?? ""}
            disabled={disabled}
            onChange={(event) => setValue(field.name, event.target.value)}
          >
            {field.required ? null : <option value="">(not set)</option>}
            {(field.options ?? []).map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
          {field.help ? <span className="field-help">{field.help}</span> : null}
        </label>
      );
    case "partialDate":
      return (
        <fieldset className="date-fieldset">
          <legend>{field.label}</legend>
          <label>
            Year
            <input
              inputMode="numeric"
              value={values[`${field.name}.year`] ?? ""}
              disabled={disabled}
              onChange={(event) => setValue(`${field.name}.year`, event.target.value)}
            />
          </label>
          <label>
            Month
            <input
              inputMode="numeric"
              value={values[`${field.name}.month`] ?? ""}
              disabled={disabled}
              onChange={(event) => setValue(`${field.name}.month`, event.target.value)}
            />
          </label>
          <label>
            Day
            <input
              inputMode="numeric"
              value={values[`${field.name}.day`] ?? ""}
              disabled={disabled}
              onChange={(event) => setValue(`${field.name}.day`, event.target.value)}
            />
          </label>
          <span className="field-help">
            Partial dates are fine: year only, or year + month. Clear the year to unset.
          </span>
        </fieldset>
      );
    case "price":
      return (
        <fieldset className="date-fieldset">
          <legend>{field.label}</legend>
          <label>
            Amount
            <input
              inputMode="decimal"
              value={values[`${field.name}.amount`] ?? ""}
              disabled={disabled}
              onChange={(event) => setValue(`${field.name}.amount`, event.target.value)}
            />
          </label>
          <label>
            Currency
            <input
              value={values[`${field.name}.currency`] ?? "USD"}
              disabled={disabled}
              onChange={(event) => setValue(`${field.name}.currency`, event.target.value)}
            />
          </label>
        </fieldset>
      );
    default:
      return (
        <label>
          {field.label}
          <input
            value={values[field.name] ?? ""}
            disabled={disabled}
            onChange={(event) => setValue(field.name, event.target.value)}
          />
          {field.help ? <span className="field-help">{field.help}</span> : null}
        </label>
      );
  }
}
