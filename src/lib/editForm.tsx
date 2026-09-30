// Shared form plumbing for the record edit surfaces: the Moderator direct
// edit (/mod/edit, ticket #31) and the Editor update proposal (/mod/propose,
// ticket #32). Everything edits as strings keyed by field name; the submit
// handlers shape typed values that the Convex mutations re-validate against
// the same registry (convex/lib/moderationFields.ts).

import type { FieldDescriptor } from "../../convex/lib/moderationFields";

export type FormState = Record<string, string>;

export function initialFormState(
  fields: Array<FieldDescriptor & { value: unknown }>,
): FormState {
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
        state[`${field.name}.month`] =
          date.month !== undefined ? String(date.month) : "";
        state[`${field.name}.day`] = date.day !== undefined ? String(date.day) : "";
        break;
      }
      case "price": {
        const price = (value ?? {}) as { amountCents?: number; currency?: string };
        state[`${field.name}.amount`] =
          price.amountCents !== undefined
            ? (price.amountCents / 100).toFixed(2)
            : "";
        state[`${field.name}.currency`] = price.currency ?? "USD";
        break;
      }
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
      if ([parsed.year, parsed.month, parsed.day].some((n) => n !== undefined && !Number.isInteger(n))) {
        return { ok: false, message: `${descriptor.label}: year, month, and day must be whole numbers.` };
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
    default:
      return { ok: true, value: state[descriptor.name] ?? "" };
  }
}

/** Form-state keys backing one field (dirtiness is tracked per input). */
export function stateKeysOf(descriptor: FieldDescriptor): string[] {
  switch (descriptor.kind) {
    case "partialDate":
      return [
        `${descriptor.name}.year`,
        `${descriptor.name}.month`,
        `${descriptor.name}.day`,
      ];
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

export function FieldInput({
  field,
  values,
  setValue,
}: {
  field: FieldDescriptor & { value: unknown };
  values: FormState;
  setValue: (key: string, value: string) => void;
}) {
  switch (field.kind) {
    case "textarea":
    case "stringList":
      return (
        <label>
          {field.label}
          <textarea
            value={values[field.name] ?? ""}
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
              onChange={(event) => setValue(`${field.name}.year`, event.target.value)}
            />
          </label>
          <label>
            Month
            <input
              inputMode="numeric"
              value={values[`${field.name}.month`] ?? ""}
              onChange={(event) => setValue(`${field.name}.month`, event.target.value)}
            />
          </label>
          <label>
            Day
            <input
              inputMode="numeric"
              value={values[`${field.name}.day`] ?? ""}
              onChange={(event) => setValue(`${field.name}.day`, event.target.value)}
            />
          </label>
          <span className="field-help">
            Partial dates are fine: year only, or year + month. Clear the year
            to unset.
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
              onChange={(event) => setValue(`${field.name}.amount`, event.target.value)}
            />
          </label>
          <label>
            Currency
            <input
              value={values[`${field.name}.currency`] ?? "USD"}
              onChange={(event) =>
                setValue(`${field.name}.currency`, event.target.value)
              }
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
            onChange={(event) => setValue(field.name, event.target.value)}
          />
          {field.help ? <span className="field-help">{field.help}</span> : null}
        </label>
      );
  }
}

/** A readable error message out of any thrown mutation error. */
export function mutationErrorMessage(err: unknown, fallback: string): string {
  const data = (err as { data?: unknown })?.data;
  if (typeof data === "object" && data !== null) {
    const record = data as { message?: unknown; kind?: unknown };
    if (record.kind === "RateLimited") {
      return "Slow down — you have hit the per-user rate limit. Try again in a few minutes.";
    }
    if (typeof record.message === "string") return record.message;
  }
  if (typeof data === "string") return data;
  return fallback;
}
