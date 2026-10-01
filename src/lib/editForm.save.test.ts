// The Moderator direct-edit form (routes/mod.edit.$type.$key.tsx) driven as
// plain functions: React's useState, the router and convex/react are
// replaced by a tiny harness so a test can type, save, hold the mutation
// open, and read what the form shows at every step.

import { getFunctionName } from "convex/server";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  slots: [] as unknown[],
  cursor: 0,
  form: null as Record<string, unknown> | null,
  submit: vi.fn(),
  navigate: vi.fn(),
}));

// useState backed by slots that survive re-renders of the same component.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  function useState<S>(initial: S | (() => S)) {
    const index = harness.cursor++;
    if (!(index in harness.slots)) {
      harness.slots[index] = typeof initial === "function" ? (initial as () => S)() : initial;
    }
    const set = (next: S | ((prev: S) => S)) => {
      harness.slots[index] =
        typeof next === "function" ? (next as (prev: S) => S)(harness.slots[index] as S) : next;
    };
    return [harness.slots[index] as S, set] as const;
  }
  return { ...actual, useState };
});
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({
    options,
    useParams: () => ({ type: "publisher", key: "pub-a" }),
  }),
  Link: "a",
  useNavigate: () => harness.navigate,
}));
vi.mock("convex/react", () => ({
  useQuery: (ref: Parameters<typeof getFunctionName>[0]) =>
    getFunctionName(ref) === "users:viewer" ? { username: "mod" } : harness.form,
  useMutation: () => harness.submit,
}));
vi.mock("~/lib/moderation", () => ({ useIsModerator: () => true }));
vi.mock("~/providers", () => ({ convexClient: {} }));

const { Route } = await import("../routes/mod.edit.$type.$key");
const { FieldInput } = await import("./editForm");

/** The editForm query's answer for a Publisher named `name`. */
function liveForm(name: string, baseRevisionId: string | null = null) {
  return {
    fields: [{ name: "name", label: "Name", kind: "text", required: true, value: name }],
    ref: { type: "publisher", id: "pub-a" },
    baseRevisionId,
    status: "active",
    locked: false,
    title: name,
    overriddenFields: [],
    backLink: null,
  };
}

type Node = ReactElement<Record<string, unknown>>;
function nodes(node: ReactNode): Node[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...nodes(node.props.children as ReactNode)];
}

/** Render page → gate → form with a fresh hook cursor; slots persist. */
function render() {
  const page = (Route.options.component as () => Node)();
  const gate = (page.type as (props: Record<string, unknown>) => Node)(page.props);
  harness.cursor = 0;
  const all = nodes((gate.type as (props: Record<string, unknown>) => Node)(gate.props));
  const field = all.find((node) => node.type === FieldInput)!;
  return {
    field,
    form: all.find((node) => node.type === "form")!,
    comment: all.find((node) => node.type === "textarea")!,
    submit: all.find((node) => node.type === "button" && node.props.type === "submit")!,
    values: field.props.values as Record<string, string>,
  };
}

function type(name: string) {
  (render().field.props.setValue as (key: string, value: string) => void)("name", name);
}
function comment(text: string) {
  (render().comment.props.onChange as (event: unknown) => void)({ target: { value: text } });
}
function save() {
  (render().form.props.onSubmit as (event: unknown) => void)({ preventDefault() {} });
}

beforeEach(() => {
  harness.slots = [];
  harness.cursor = 0;
  harness.form = liveForm("Original");
  harness.submit.mockReset().mockResolvedValue({ seq: 1 });
  harness.navigate.mockReset().mockResolvedValue(undefined);
});

describe("direct edit while a save is pending (review R18)", () => {
  /** Save "First correction" and hold the mutation open; returns its resolver. */
  function pendingSave() {
    let resolve!: (value: { seq: number }) => void;
    harness.submit.mockImplementation(() => new Promise((r) => (resolve = r)));
    type("First correction");
    comment("Corrected name");
    save();
    return (seq: number) => resolve({ seq });
  }

  it("locks every input until the save settles", () => {
    pendingSave();
    const pending = render();
    expect(pending.field.props.disabled).toBe(true);
    expect(pending.comment.props.disabled).toBe(true);
    expect(pending.submit.props.disabled).toBe(true);
  });

  it("never shows a second correction that the save's reset would discard", async () => {
    const resolve = pendingSave();
    // Whatever reaches the handlers while saving (a queued keystroke) is ignored.
    type("Second correction typed while saving");
    comment("A second comment");
    const shown = render();
    const shownName = shown.values.name;
    const shownComment = shown.comment.props.value;

    harness.form = liveForm("First correction", "r1");
    resolve(1);
    await vi.waitFor(() => expect(render().submit.props.children).not.toBe("Saving…"));

    // Every value the form displayed was either saved or is still displayed.
    expect(harness.submit).toHaveBeenCalledTimes(1);
    expect(harness.submit).toHaveBeenCalledWith(
      expect.objectContaining({ changes: [{ field: "name", value: "First correction" }] }),
    );
    const settled = render();
    expect(["First correction", settled.values.name]).toContain(shownName);
    expect(["Corrected name", settled.comment.props.value]).toContain(shownComment);
    expect(settled.values.name).toBe("First correction");
    expect(settled.field.props.disabled).toBe(false);
    // The unlocked form takes the next correction on the new base.
    type("Second correction");
    comment("Another fix");
    expect(render().values.name).toBe("Second correction");
    expect(render().submit.props.disabled).toBe(false);
  });

  it("stays locked through the return navigation after a save with a back link", async () => {
    let arrive!: () => void;
    harness.navigate.mockImplementation(() => new Promise<void>((r) => (arrive = r)));
    const backLink = { entity: "series", publicId: 7, title: "Alpha" };
    harness.form = { ...liveForm("Original"), backLink };
    type("First correction");
    comment("Corrected name");
    save();
    await vi.waitFor(() => expect(harness.navigate).toHaveBeenCalled());
    expect(render().field.props.disabled).toBe(true);
    type("Typed on the way out");
    expect(render().values.name).not.toBe("Typed on the way out");
    arrive();
  });

  it("locks every control of every field kind", () => {
    const kinds = ["text", "textarea", "stringList", "select", "partialDate", "price"] as const;
    for (const kind of kinds) {
      const field = { name: "f", label: "F", kind, required: false, options: ["a"], value: null };
      const rendered = FieldInput({ field, values: {}, setValue: () => undefined, disabled: true });
      const controls = nodes(rendered).filter((node) =>
        ["input", "select", "textarea"].includes(node.type as string),
      );
      expect(controls.length, kind).toBeGreaterThan(0);
      for (const control of controls) expect(control.props.disabled, kind).toBe(true);
    }
  });

  it("keeps the draft and unlocks the inputs when the save fails", async () => {
    let reject!: (err: Error) => void;
    harness.submit.mockImplementation(() => new Promise((_, r) => (reject = r)));
    type("First correction");
    comment("Corrected name");
    save();
    expect(render().field.props.disabled).toBe(true);
    reject(new Error("offline"));
    await vi.waitFor(() => expect(render().field.props.disabled).toBe(false));
    expect(render().values.name).toBe("First correction");
    expect(render().comment.props.value).toBe("Corrected name");
  });
});
