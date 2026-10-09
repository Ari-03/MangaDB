// The reader's suggest page (routes/suggest.$type.$key.tsx, the shared
// lib/proposeForm.tsx in "suggest" mode) driven as plain functions through
// the fake React in test.react.ts: a signed-out visitor is asked to sign in
// and come back, a reader is offered no override clears, and a Draft sent
// back for changes resumes with its values and saves into the same Proposal.

import { getFunctionName } from "convex/server";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mount, press, resetHarness, text, type Host } from "./test.react";

const fakes = vi.hoisted(() => ({
  viewer: null as Record<string, unknown> | null | undefined,
  form: null as Record<string, unknown> | null,
  own: null as Record<string, unknown> | null,
  search: {} as { draft?: string },
  saveDraft: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({
    options,
    useParams: () => ({ type: "publisher", key: "pub-a" }),
    useSearch: () => fakes.search,
  }),
  Link: "a",
  useNavigate: () => vi.fn(),
  useLocation: () => ({ href: "/suggest/publisher/pub-a#cover" }),
}));
vi.mock("convex/react", () => ({
  useQuery: (ref: Parameters<typeof getFunctionName>[0]) =>
    getFunctionName(ref) === "suggestions:detail" ? fakes.own : fakes.form,
  useMutation: () => fakes.saveDraft,
}));
vi.mock("~/lib/viewer", () => ({
  useViewerQuery: () => fakes.viewer,
  useIsDataTeam: () => false,
  useIsModerator: () => false,
}));

const { Route } = await import("../routes/suggest.$type.$key");
const page = Route.options.component as () => ReactNode;

/** The editForm query's answer: a Publisher whose name is a Human Override. */
const liveForm = {
  fields: [
    { name: "name", label: "Name", kind: "text", required: true, value: "Original" },
    { name: "website", label: "Website", kind: "text", required: false, value: null },
  ],
  ref: { type: "publisher", id: "pub-a" },
  baseRevisionId: "r1",
  importReviewPending: null,
  status: "active",
  locked: false,
  title: "Original",
  overriddenFields: ["name"],
  overrides: [{ field: "name", label: "Name", writtenBy: { kind: "human" } }],
  backLink: null,
  cover: null,
  attribution: null,
};

const textInputs = (tree: Host[]) =>
  tree.filter(
    (host) => host.type === "input" && host.props.type !== "checkbox" && host.props.type !== "url",
  );
const shows = (tree: Host[], words: string) =>
  tree.some((host) => text(host.props.children).includes(words));

beforeEach(() => {
  resetHarness();
  fakes.viewer = { needsUsername: false, username: "dave" };
  fakes.form = liveForm;
  fakes.own = null;
  fakes.search = {};
  fakes.saveDraft.mockReset().mockResolvedValue({ proposalId: "p1" });
});

describe("the suggest page", () => {
  it("asks a signed-out visitor to sign in and come back here", () => {
    fakes.viewer = null;
    const tree = mount(page);
    const signIn = tree.find(
      (host) => host.type === "a" && text(host.props.children) === "Sign in",
    );
    expect(signIn?.props.href).toBe(
      `/sign-in?redirect_url=${encodeURIComponent("/suggest/publisher/pub-a#cover")}`,
    );
    expect(tree.some((host) => host.type === "form")).toBe(false);
  });

  it("offers a reader field changes but no override clears", async () => {
    const tree = mount(page);
    expect(shows(tree, "Suggest a change")).toBe(true);
    expect(tree.some((host) => host.type === "input" && host.props.type === "checkbox")).toBe(
      false,
    );
    (textInputs(tree)[1]!.props.onChange as (event: unknown) => void)({
      target: { value: "https://publisher.example" },
    });
    press(mount(page), "Save draft").click();
    await vi.waitFor(() => expect(fakes.saveDraft).toHaveBeenCalledTimes(1));
    expect(fakes.saveDraft.mock.calls[0]![0]).toMatchObject({
      proposalId: undefined,
      ops: [
        {
          kind: "update",
          ref: { type: "publisher", id: "pub-a" },
          changes: [{ field: "website", value: "https://publisher.example" }],
        },
      ],
    });
  });

  it("resumes a Draft sent back for changes and saves into it", async () => {
    fakes.search = { draft: "p9" };
    fakes.own = {
      proposalId: "p9",
      state: "draft",
      coverArt: [],
      draft: {
        comment: "From the colophon.",
        evidence: [{ kind: "url", url: "https://publisher.example/about", note: null }],
        ops: [
          {
            kind: "update",
            recordType: "publisher",
            recordId: "pub-a",
            changes: [{ field: "website", before: undefined, after: "https://old.example" }],
          },
        ],
      },
    };
    const tree = mount(page);
    expect(textInputs(tree)[1]!.props.value).toBe("https://old.example");
    expect(
      tree.find((host) => host.type === "input" && host.props.type === "url")!.props.value,
    ).toBe("https://publisher.example/about");
    expect(shows(tree, "You are revising a saved draft.")).toBe(true);

    (textInputs(tree)[1]!.props.onChange as (event: unknown) => void)({
      target: { value: "https://publisher.example" },
    });
    press(mount(page), "Save draft").click();
    await vi.waitFor(() => expect(fakes.saveDraft).toHaveBeenCalledTimes(1));
    expect(fakes.saveDraft.mock.calls[0]![0]).toMatchObject({
      proposalId: "p9",
      comment: "From the colophon.",
      evidence: [{ kind: "url", url: "https://publisher.example/about" }],
      ops: [
        { kind: "update", changes: [{ field: "website", value: "https://publisher.example" }] },
      ],
    });
  });

  it("will not resume a suggestion that is no longer a Draft", () => {
    fakes.search = { draft: "p9" };
    fakes.own = { proposalId: "p9", state: "inReview", coverArt: [], draft: null };
    const tree = mount(page);
    expect(shows(tree, "no longer a draft")).toBe(true);
    expect(tree.some((host) => host.type === "form")).toBe(false);
  });
});
