// The Editor's update-proposal form (routes/mod.propose.$type.$key.tsx)
// driven as plain functions through the fake React in test.react.ts: the
// editForm query's answer is swapped between renders to play a concurrent
// change, and saveDraft is a spy holding the ops the form would send.

import { getFunctionName } from "convex/server";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mount, press, resetHarness, type Host } from "./test.react";

const fakes = vi.hoisted(() => ({
  form: null as Record<string, unknown> | null,
  saveDraft: vi.fn(),
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
    getFunctionName(ref) === "users:viewer" ? { username: "carol" } : fakes.form,
  useMutation: () => fakes.saveDraft,
}));
vi.mock("~/lib/viewer", () => ({ useIsDataTeam: () => true, useIsModerator: () => false }));

const { Route } = await import("../routes/mod.propose.$type.$key");
const page = Route.options.component as () => ReactNode;

/** The editForm query's answer: a Publisher with a name (overridden or not) and a website. */
function liveForm(name: string, baseRevisionId: string, overridden = true) {
  return {
    fields: [
      { name: "name", label: "Name", kind: "text", required: true, value: name },
      { name: "website", label: "Website", kind: "text", required: false, value: null },
    ],
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

const textInputs = (tree: Host[]) =>
  tree.filter((host) => host.type === "input" && host.props.type !== "checkbox" && host.props.type !== "url");
const checkbox = (tree: Host[]) => tree.find((host) => host.type === "input" && host.props.type === "checkbox");

function typeWebsite(value: string) {
  (textInputs(mount(page))[1]!.props.onChange as (event: unknown) => void)({ target: { value } });
}
function tickClear(checked: boolean) {
  (checkbox(mount(page))!.props.onChange as (event: unknown) => void)({ target: { checked } });
}
function writeComment(value: string) {
  const box = mount(page).find((host) => host.type === "textarea" && host.props.required === true)!;
  (box.props.onChange as (event: unknown) => void)({ target: { value } });
}

beforeEach(() => {
  resetHarness();
  fakes.form = liveForm("Original", "r1");
  fakes.saveDraft.mockReset().mockResolvedValue({ proposalId: "p1" });
});

describe("proposing a change while the record changes", () => {
  it("asks for a reload before saving ops anchored on a state the Editor has not seen", async () => {
    typeWebsite("https://publisher.example");
    tickClear(true);
    writeComment("Website from the colophon; let imports weigh the name.");

    // Another Moderator renames the publisher; the pinned form still shows the old name.
    fakes.form = liveForm("Renamed", "r2");
    const changed = mount(page);
    expect(textInputs(changed)[0]!.props.value).toBe("Original");
    expect(changed.some((host) => host.props.role === "alert")).toBe(true);
    expect(press(changed, "Save draft").disabled).toBe(true);
    expect(press(changed, "Submit for review").disabled).toBe(true);
    const form = changed.find((host) => host.type === "form")!;
    (form.props.onSubmit as (event: unknown) => void)({ preventDefault() {} });
    expect(fakes.saveDraft).not.toHaveBeenCalled();

    // Reloading shows the live record and drops the edits and ticks made against the old one.
    press(changed, "Reload latest").click();
    const reloaded = mount(page);
    expect(textInputs(reloaded)[0]!.props.value).toBe("Renamed");
    expect(checkbox(reloaded)!.props.checked).toBe(false);
    tickClear(true);
    press(mount(page), "Save draft").click();
    await vi.waitFor(() => expect(fakes.saveDraft).toHaveBeenCalledTimes(1));
    expect(fakes.saveDraft.mock.calls[0]![0].ops).toEqual([
      { kind: "clearOverride", ref: { type: "publisher", id: "pub-a" }, field: "name" },
    ]);
  });

  it("drops a ticked clear whose override someone else lifted", async () => {
    typeWebsite("https://publisher.example");
    tickClear(true);
    // The override goes without a Revision (as data from before history might), so the base holds.
    fakes.form = liveForm("Original", "r1", false);
    press(mount(page), "Save draft").click();
    await vi.waitFor(() => expect(fakes.saveDraft).toHaveBeenCalledTimes(1));
    expect(fakes.saveDraft.mock.calls[0]![0].ops).toEqual([
      {
        kind: "update",
        ref: { type: "publisher", id: "pub-a" },
        changes: [{ field: "website", value: "https://publisher.example" }],
      },
    ]);
  });
});
