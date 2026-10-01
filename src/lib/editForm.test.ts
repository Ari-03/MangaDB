import { convexToJson, jsonToConvex } from "convex/values";
import { describe, expect, it } from "vitest";

import {
  fieldDescriptor,
  normalizeFieldValue,
  type FieldDescriptor,
} from "../../convex/lib/moderationFields";
import {
  draftChanges,
  draftIsStale,
  editDraft,
  fieldValue,
  freshDraft,
  type FormState,
} from "./editForm";

function descriptor(name: string): FieldDescriptor {
  const found = fieldDescriptor("release", name);
  if (!found) throw new Error(`no release field ${name}`);
  return found;
}

/** What the mutation receives: a change after Convex's wire serialization. */
function overTheWire(change: { field: string; value: unknown }) {
  return jsonToConvex(convexToJson(change as never)) as Record<string, unknown>;
}

describe("fieldValue clearing (audit B29)", () => {
  const cases: Array<{ name: string; state: FormState }> = [
    { name: "pubDate", state: { "pubDate.year": "", "pubDate.month": "", "pubDate.day": "" } },
    { name: "price", state: { "price.amount": "", "price.currency": "USD" } },
  ];

  for (const { name, state } of cases) {
    it(`a cleared ${name} survives serialization and clears server-side`, () => {
      const field = descriptor(name);
      const result = fieldValue(field, state);
      if (!result.ok) throw new Error(result.message);
      const sent = overTheWire({ field: name, value: result.value });
      // The mutation's validator requires `value`; undefined is dropped.
      expect(sent).toHaveProperty("value");
      expect(normalizeFieldValue(field, sent.value)).toEqual({ ok: true, value: undefined });
    });
  }
});

describe("edit drafts pin their base Revision (audit B05)", () => {
  const fields = [{ ...descriptor("price"), value: { amountCents: 999, currency: "USD" } }];

  it("keeps the base the values were loaded from after the record moves on", () => {
    // Moderator A loads revision r1 and edits the price.
    const loaded = { fields, baseRevisionId: "r1" };
    const draft = editDraft(freshDraft(loaded), "price.amount", "12.00");

    // Moderator B saves; A's reactive query now reports revision r2.
    const live = {
      fields: [{ ...fields[0]!, value: { amountCents: 1500, currency: "USD" } }],
      baseRevisionId: "r2",
    };

    expect(draft.baseRevisionId).toBe("r1");
    expect(draftIsStale(draft, live.baseRevisionId)).toBe(true);
    const changes = draftChanges(live.fields, draft);
    expect(changes).toEqual({
      ok: true,
      changes: [{ field: "price", value: { amountCents: 1200, currency: "USD" } }],
    });
  });

  it("an untouched draft tracks the live record and is never stale", () => {
    const draft = freshDraft({ fields, baseRevisionId: null });
    expect(draft.values["price.amount"]).toBe("9.99");
    expect(draft.dirty.size).toBe(0);
    expect(draftIsStale(draft, null)).toBe(false);
    expect(draftChanges(fields, draft)).toEqual({ ok: true, changes: [] });
  });
});
