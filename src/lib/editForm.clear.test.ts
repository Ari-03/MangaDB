// The Clear control on the Moderator edit page (routes/mod.edit.$type.$key.tsx,
// HumanOverrides) driven as plain functions through the fake React in
// test.react.ts: the editForm query's answer is swapped between renders to
// play a concurrent change, and the clear mutation is a spy.

import { getFunctionName } from "convex/server";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mount, press, resetHarness, text, type Host } from "./test.react";

// The editForm query's answer and the two mutations the page holds.
const fakes = vi.hoisted(() => ({
  form: null as Record<string, unknown> | null,
  clear: vi.fn(),
  edit: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({
    options,
    useParams: () => ({ type: "publisher", key: "pub-a" }),
  }),
  Link: "a",
  useNavigate: () => vi.fn(),
}));
vi.mock("convex/react", () => ({
  useQuery: (ref: Parameters<typeof getFunctionName>[0]) =>
    getFunctionName(ref) === "users:viewer" ? { username: "mod" } : fakes.form,
  useMutation: (ref: Parameters<typeof getFunctionName>[0]) =>
    getFunctionName(ref) === "moderation:submitDirectClear" ? fakes.clear : fakes.edit,
}));
vi.mock("~/lib/viewer", () => ({ useIsModerator: () => true }));

const { Route } = await import("../routes/mod.edit.$type.$key");
const page = Route.options.component as () => ReactNode;

/** The editForm query's answer: a Publisher whose name a person corrected, overridden or not. */
function liveForm(name: string, baseRevisionId: string, overridden = true) {
  return {
    fields: [{ name: "name", label: "Name", kind: "text", required: true, value: name }],
    ref: { type: "publisher", id: "pub-a" },
    baseRevisionId,
    importReviewPending: false,
    status: "active",
    locked: false,
    title: name,
    overriddenFields: overridden ? ["name"] : [],
    overrides: overridden ? [{ field: "name", label: "Name", writtenBy: { kind: "human" } }] : [],
    backLink: null,
  };
}

const reasonBox = (tree: Host[]) =>
  tree.find((host) => host.type === "textarea" && host.props.placeholder === "Why should imports weigh this field again?");
/** The value the Clear preview says stays. */
const keptValue = (tree: Host[]) => text(tree.find((host) => host.type === "code")?.props.children);
const notices = (tree: Host[]) =>
  tree.filter((host) => host.props.className === "notice").map((host) => text(host.props.children));

function writeReason(value: string) {
  (reasonBox(mount(page))!.props.onChange as (event: unknown) => void)({ target: { value } });
}
/** Submit the Clear form (the first form on the page), as Enter would even past a disabled button. */
function confirmClear() {
  const form = mount(page).find((host) => host.type === "form")!;
  (form.props.onSubmit as (event: unknown) => void)({ preventDefault() {} });
}

beforeEach(() => {
  resetHarness();
  fakes.form = liveForm("Original", "r1");
  fakes.clear.mockReset().mockResolvedValue({ seq: 5 });
  fakes.edit.mockReset();
});

describe("clearing a Human Override directly", () => {
  it("submits the base it showed, and waits for a review when the record changes meanwhile", async () => {
    press(mount(page), "Clear").click();
    writeReason("The publisher's page is right again.");
    expect(keptValue(mount(page))).toBe("Original");

    // Another Moderator renames the publisher; the override stays.
    fakes.form = liveForm("Renamed", "r2");
    const changed = mount(page);
    expect(press(changed, "Clear override").disabled).toBe(true);
    expect(changed.some((host) => host.props.role === "alert")).toBe(true);
    expect(keptValue(changed)).toBe("Original");
    confirmClear();
    expect(fakes.clear).not.toHaveBeenCalled();

    // Reviewing the current state captures it; the reason is kept.
    press(changed, "Review current state").click();
    const reviewed = mount(page);
    expect(keptValue(reviewed)).toBe("Renamed");
    expect(reviewed.some((host) => host.props.role === "alert")).toBe(false);
    expect(reasonBox(reviewed)!.props.value).toBe("The publisher's page is right again.");
    expect(press(reviewed, "Clear override").disabled).toBe(false);
    confirmClear();
    expect(fakes.clear).toHaveBeenCalledTimes(1);
    expect(fakes.clear).toHaveBeenCalledWith(
      expect.objectContaining({ field: "name", baseRevisionId: "r2" }),
    );
  });

  it("closes instead of reloading when the override is gone", () => {
    fakes.form = { ...liveForm("Original", "r1"), overriddenFields: ["name", "website"] };
    press(mount(page), "Clear").click();
    fakes.form = { ...liveForm("Original", "r2", false), overriddenFields: ["website"] };
    press(mount(page), "Review current state").click();
    const closed = mount(page);
    expect(reasonBox(closed)).toBeUndefined();
    expect(text(closed.find((host) => host.props.className === "form-error")?.props.children)).toBe(
      "Name is no longer overridden; there is nothing to clear.",
    );
  });

  it("says the last override was cleared after the panel disappears", async () => {
    press(mount(page), "Clear").click();
    writeReason("The publisher's page is right again.");
    confirmClear();
    await vi.waitFor(() => expect(press(mount(page), "Clear").disabled).toBe(false));

    // The live query drops the override, and the panel with it.
    fakes.form = liveForm("Original", "r2", false);
    const after = mount(page);
    expect(after.some((host) => host.type === "h2" && text(host.props.children) === "Human Overrides")).toBe(false);
    expect(notices(after)).toContain("Override on Name cleared — revision #5 recorded.");
  });
});
