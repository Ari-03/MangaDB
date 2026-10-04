// "Prepare placement" on the pages, driven against convex-test through the
// fake React in test.react.ts: the Held books list on /mod/imports
// (routes/mod.imports.tsx Placement) and the placement panel of the
// Proposal page (routes/mod.proposal.$id.tsx PlacementPanel). useQuery and
// usePaginatedQuery answer from snapshots the tests take from the backend.

import { getFunctionName, type FunctionReference } from "convex/server";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { recordUnplaced } from "../../convex/lib/observations";
import { parseDumpLine } from "../../convex/lib/openLibrary";
import {
  insertObservation,
  insertPublisher,
  insertSeries,
  insertVolume,
} from "../../convex/test.factories";
import {
  alice,
  bob,
  carol,
  makeT,
  seedTeam,
  signedIn,
  type TestT,
  type TestUser,
} from "../../convex/test.helpers";
import {
  harness,
  mount,
  press,
  resetHarness,
  setQuery,
  settle,
  text,
  type Host,
} from "./test.react";

// The page's navigate spy, and the Proposal the Proposal page's route names.
const fakes = vi.hoisted(() => {
  const state: { navigate: ReturnType<typeof vi.fn>; proposalId: Id<"proposals"> | null } = {
    navigate: vi.fn(),
    proposalId: null,
  };
  return state;
});

vi.mock("convex/react", async () => {
  const { backendHooks, harness: state } = await import("./test.react");
  return {
    ...backendHooks,
    usePaginatedQuery: (ref: FunctionReference<"query">) => ({
      results: state.snapshot.get(getFunctionName(ref)) ?? [],
      status: "Exhausted",
      loadMore: () => undefined,
    }),
  };
});
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({
    options,
    useParams: () => ({ id: fakes.proposalId }),
  }),
  Link: "a",
  useNavigate: () => fakes.navigate,
}));
vi.mock("~/lib/viewer", () => ({ useIsDataTeam: () => true, useIsModerator: () => false }));

const imports = (await import("../routes/mod.imports")).Route.options.component as () => ReactNode;
const proposal = (await import("../routes/mod.proposal.$id")).Route.options
  .component as () => ReactNode;

/** An Open Library edition's snapshot, as the dump parser stores it. */
const olSnapshot = (key: string, title: string, isbn: string) =>
  parseDumpLine(
    `/type/edition\t${key}\t1\t2026-08-01T00:00:00\t${JSON.stringify({
      key,
      title,
      publishers: ["Viz Media"],
      isbn_13: [isbn],
      physical_format: "paperback",
      languages: [{ key: "/languages/eng" }],
    })}`,
  )!;

/**
 * VIZ, "Alice in Borderland" with Volume 4 and "Vagabond" with Volumes 10
 * and 11, and three held Open Library books: Alice 1 (a missing Volume),
 * Vagabond's Definitive Edition 4 (packaging), and one no Series fits.
 */
async function seed(t: TestT) {
  await seedTeam(t, [alice, bob, carol]);
  return await t.run(async (ctx) => {
    await insertPublisher(ctx, { name: "VIZ Media", slug: "viz-media" });
    const aliceId = await insertSeries(ctx, { publicId: 7, title: "Alice in Borderland" });
    await insertVolume(ctx, { seriesId: aliceId, position: 4, label: "4" });
    const vagabondId = await insertSeries(ctx, { publicId: 8, title: "Vagabond" });
    await insertVolume(ctx, { seriesId: vagabondId, position: 10, label: "10" });
    await insertVolume(ctx, { seriesId: vagabondId, position: 11, label: "11" });
    const hold = async (
      snapshot: ReturnType<typeof olSnapshot>,
      kind: "volumeMissing" | "packaging" | "series",
      seriesId?: Id<"series">,
    ) => {
      const id = await insertObservation(ctx, {
        sourceKey: "openlibrary",
        sourceRecordId: snapshot.key,
        snapshot,
      });
      await recordUnplaced(
        ctx,
        (await ctx.db.get(id))!,
        { kind, reason: "Held.", seriesId },
        Date.now(),
      );
      return id;
    };
    return {
      alice1: await hold(
        olSnapshot("/books/OL1M", "Alice in Borderland, Vol. 1", "9781974728374"),
        "volumeMissing",
        aliceId,
      ),
      vagabond4: await hold(
        olSnapshot("/books/OL2M", "Vagabond Definitive Edition, Vol. 4", "9781974700400"),
        "packaging",
        vagabondId,
      ),
      nobody: await hold(olSnapshot("/books/OL3M", "Nobody, Vol. 1", "9781974700011"), "series"),
    };
  });
}

/** Sign `user` in to the pages and take the queries' answers from the backend as they stand. */
async function show(t: TestT, user: TestUser) {
  const as = signedIn(t, user);
  harness.backend = as;
  setQuery(api.users.viewer, { username: user.username });
  setQuery(api.imports.dashboard, []);
  setQuery(api.imports.recentRuns, []);
  setQuery(
    api.imports.heldBooks,
    (await as.query(api.imports.heldBooks, { paginationOpts: { numItems: 25, cursor: null } }))
      .page,
  );
  if (fakes.proposalId !== null) {
    setQuery(
      api.proposals.proposalDetail,
      await as.query(api.proposals.proposalDetail, { proposalId: fakes.proposalId }),
    );
  }
}

/** The held book row titled `title`: its hosts, between its title and the next row's. */
function row(tree: Host[], title: string): Host[] {
  const items = tree.filter((host) => host.type === "li" && host.props.className === "import-run");
  const item = items.find((host) => text(host.props.children).includes(title));
  if (!item) throw new Error(`No held book "${title}"`);
  const start = tree.indexOf(item);
  const next = items[items.indexOf(item) + 1];
  return tree.slice(start, next === undefined ? undefined : tree.indexOf(next));
}

const typeInto = (input: Host | undefined, value: string) =>
  (input!.props.onChange as (event: unknown) => void)({
    target: { value, checked: value === "on" },
  });

beforeEach(() => {
  resetHarness();
  fakes.navigate.mockReset();
  fakes.proposalId = null;
});

describe("Held books on /mod/imports", () => {
  it("prepares a held book and opens its Draft, then marks the book while the Draft is open", async () => {
    const t = makeT();
    const { alice1 } = await seed(t);
    await show(t, carol);
    press(row(mount(imports), "Alice in Borderland, Vol. 1"), "Prepare placement").click();
    await settle();
    const proposals = await t.run((ctx) => ctx.db.query("proposals").collect());
    expect(proposals).toHaveLength(1);
    expect(fakes.navigate).toHaveBeenCalledWith({
      to: "/mod/proposal/$id",
      params: { id: proposals[0]!._id },
    });
    expect(await t.run(async (ctx) => (await ctx.db.get(alice1))?.queuedProposalId)).toBe(
      proposals[0]!._id,
    );

    await show(t, carol);
    const marked = row(mount(imports), "Alice in Borderland, Vol. 1");
    expect(
      marked.some(
        (host) => host.type === "button" && text(host.props.children) === "Prepare placement",
      ),
    ).toBe(false);
    expect(
      text(marked.map((host) => (host.type === "span" ? host.props.children : null))),
    ).toContain("Placement Draft");
    expect(
      marked.find((host) => host.type === "a" && text(host.props.children) === "Open the Proposal")
        ?.props.params,
    ).toEqual({
      id: proposals[0]!._id,
    });
  });

  it("offers another member Prepare placement beside a Draft that is not theirs, and only the link beside their own", async () => {
    const t = makeT();
    const { alice1 } = await seed(t);
    const first = await signedIn(t, carol).mutation(api.placement.preparePlacement, {
      observationId: alice1,
    });
    const buttons = (tree: Host[]) =>
      row(tree, "Alice in Borderland, Vol. 1")
        .filter((host) => host.type === "button")
        .map((host) => text(host.props.children));
    await show(t, carol);
    expect(buttons(mount(imports))).toEqual([]);
    await show(t, bob);
    expect(buttons(mount(imports))).toEqual(["Prepare placement"]);
    press(row(mount(imports), "Alice in Borderland, Vol. 1"), "Prepare placement").click();
    await settle();
    const proposals = await t.run((ctx) => ctx.db.query("proposals").collect());
    expect(
      proposals.map((proposal) => [
        proposal._id === (first.status === "prepared" ? first.proposalId : null),
        proposal.state,
      ]),
    ).toEqual([
      [true, "withdrawn"],
      [false, "draft"],
    ]);
    expect(fakes.navigate).toHaveBeenCalledWith({
      to: "/mod/proposal/$id",
      params: { id: proposals[1]!._id },
    });
  });

  it("says why a book cannot be prepared, and writes nothing", async () => {
    const t = makeT();
    await seed(t);
    await show(t, carol);
    press(row(mount(imports), "Nobody, Vol. 1"), "Prepare placement").click();
    await settle();
    const refusal = row(mount(imports), "Nobody, Vol. 1").find(
      (host) => host.props.className === "form-error",
    );
    expect(text(refusal?.props.children)).toMatch(
      /^Cannot prepare: No single active, unlocked Series fits this book/,
    );
    expect(fakes.navigate).not.toHaveBeenCalled();
    expect(await t.run((ctx) => ctx.db.query("proposals").collect())).toEqual([]);
  });
});

describe("the placement panel on the Proposal page", () => {
  async function preparedVagabond(t: TestT) {
    const { vagabond4 } = await seed(t);
    const result = await signedIn(t, carol).mutation(api.placement.preparePlacement, {
      observationId: vagabond4,
    });
    if (result.status === "unavailable") throw new Error(result.reason);
    fakes.proposalId = result.proposalId;
    return result.proposalId;
  }
  const pageText = (tree: Host[]) =>
    tree
      .filter((host) => host.type === "li" || host.props.className === "notice")
      .map((host) => text(host.props.children));

  it("shows the source beside what approval creates, keeps Submit off until the coverage is stated, then saves it", async () => {
    const t = makeT();
    const proposalId = await preparedVagabond(t);
    await show(t, carol);
    const before = mount(proposal);
    expect(pageText(before)).toEqual(
      expect.arrayContaining([
        "Title: Vagabond Definitive Edition, Vol. 4",
        "Volume label: none (a book number on a line is not a Volume)",
        "Edition Line: Definitive Edition 4",
        "Publisher: Viz Media",
        "ISBN-13: 9781974700400",
        "Edition at viz-media covering: not stated yet",
        "Edition Line: Definitive Edition 4 (new line)",
      ]),
    );
    expect(
      pageText(before).some((line) => line.includes("cannot be submitted until you state it")),
    ).toBe(true);
    expect(press(before, "Submit for review").disabled).toBe(true);

    const inputs = before.filter((host) => host.type === "input");
    typeInto(inputs[0], "10");
    typeInto(inputs[1], "12");
    const form = mount(proposal).find((host) => host.type === "form")!;
    (form.props.onSubmit as (event: unknown) => void)({ preventDefault() {} });
    await settle();

    await show(t, carol);
    const after = mount(proposal);
    expect(pageText(after)).toContain(
      "Edition at viz-media covering: Volume 10, Volume 11, Volume 12 (new)",
    );
    expect(press(after, "Submit for review").disabled).toBe(false);
    press(after, "Submit for review").click();
    await settle();
    expect(await t.run(async (ctx) => (await ctx.db.get(proposalId))?.state)).toBe("inReview");
  });

  it("suggests Volume 1 for Alice's book 1, saving it only when the author accepts it, and fills the form with it", async () => {
    const t = makeT();
    const { alice1 } = await seed(t);
    const result = await signedIn(t, carol).mutation(api.placement.preparePlacement, {
      observationId: alice1,
    });
    if (result.status === "unavailable") throw new Error(result.reason);
    fakes.proposalId = result.proposalId;
    await show(t, carol);
    const before = mount(proposal);
    expect(pageText(before)).toEqual(
      expect.arrayContaining([
        "Edition at viz-media covering: not stated yet",
        "Check that this book is the manga and not a novel of the same title, and that its number is its Volume number.",
      ]),
    );
    expect(press(before, "Submit for review").disabled).toBe(true);
    press(before, "Accept Volume 1").click();
    await settle();

    await show(t, carol);
    const after = mount(proposal);
    expect(pageText(after)).toContain("Edition at viz-media covering: Volume 1 (new)");
    expect(
      after.some(
        (host) => host.type === "button" && text(host.props.children) === "Accept Volume 1",
      ),
    ).toBe(false);
    expect(press(after, "Submit for review").disabled).toBe(false);
    expect(
      after
        .filter((host) => host.type === "input")
        .map((host) => host.props.value ?? host.props.checked),
    ).toEqual(["1", "1", false, "", ""]);

    // A later Save, say of the comment alone, keeps Volume 1.
    const comment = after.find((host) => host.type === "textarea");
    typeInto(comment, "Volume 1, checked against the cover.");
    const form = mount(proposal).find((host) => host.type === "form")!;
    (form.props.onSubmit as (event: unknown) => void)({ preventDefault() {} });
    await settle();
    await show(t, carol);
    const saved = mount(proposal);
    expect(saved.some((host) => host.props.className === "form-error")).toBe(false);
    expect(pageText(saved)).toContain("Edition at viz-media covering: Volume 1 (new)");
    expect((await t.run((ctx) => ctx.db.get(result.proposalId)))?.draft?.comment).toBe(
      "Volume 1, checked against the cover.",
    );
  });

  it("shows another member the placement without the form", async () => {
    const t = makeT();
    await preparedVagabond(t);
    await show(t, bob);
    const tree = mount(proposal);
    expect(pageText(tree)).toContain("Title: Vagabond Definitive Edition, Vol. 4");
    expect(tree.some((host) => host.type === "form")).toBe(false);
  });
});
