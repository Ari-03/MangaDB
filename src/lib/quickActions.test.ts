// Cover quick actions and whole-run controls, driven end to end against
// convex-test: the components run as plain functions with convex/react's
// hooks wired straight to the test backend, so a click writes through the
// real mutations and the assertions read the resulting rows.

import { convexTest } from "convex-test";
import type { FunctionReference } from "convex/server";
import { getFunctionName } from "convex/server";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { MANY_ENTRIES_CAP } from "../../convex/collection";
import { MANY_EDITIONS_CAP } from "../../convex/reading";
import schema from "../../convex/schema";

type Backend = ReturnType<ReturnType<typeof convexTest>["withIdentity"]>;

// State shared with the hoisted mocks: the signed-in backend, the query
// snapshot useQuery answers from, an optional wrapper around every mutation
// call (see hold), the in-flight mutation promises, and the hook slots of
// the component being rendered.
const harness = vi.hoisted(() => ({
  backend: null as Backend | null,
  intercept: null as ((name: string, run: () => Promise<unknown>) => Promise<unknown>) | null,
  snapshot: new Map<string, unknown>(),
  inflight: [] as Array<Promise<unknown>>,
  slots: [] as unknown[],
  cursor: 0,
}));

vi.mock("convex/react", async () => {
  const { getFunctionName: name } = await import("convex/server");
  return {
    useQuery: (ref: FunctionReference<"query">) => harness.snapshot.get(name(ref)),
    useMutation:
      (ref: FunctionReference<"mutation">) => (args: Record<string, unknown>) => {
        const run = () => harness.backend!.mutation(ref, args);
        const call = harness.intercept ? harness.intercept(name(ref), run) : run();
        harness.inflight.push(call);
        return call;
      },
  };
});

// useState backed by slots that survive re-renders of the same component
// (a setter keeps writing the slots it was rendered with, so a component
// mounted aside keeps its own); an external store is read straight from
// its current snapshot.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  function useState<S>(initial: S | (() => S)) {
    const slots = harness.slots;
    const index = harness.cursor++;
    if (!(index in slots)) {
      slots[index] =
        typeof initial === "function" ? (initial as () => S)() : initial;
    }
    const set = (next: S | ((prev: S) => S)) => {
      slots[index] =
        typeof next === "function"
          ? (next as (prev: S) => S)(slots[index] as S)
          : next;
    };
    return [slots[index] as S, set] as const;
  }
  const useSyncExternalStore = <T,>(_subscribe: unknown, snapshot: () => T) => snapshot();
  return { ...actual, useState, useSyncExternalStore };
});

vi.mock("~/providers", () => ({ convexClient: {} }));
vi.mock("~/lib/analytics", () => ({ track: () => undefined }));
vi.mock("~/lib/mature", () => ({ useArtConcealed: () => false }));

const { BookQuickActions, RUN_BATCH, RunActions, quickBookFor, useSeriesOverlay } =
  await import("./quickActions");
const { ReleaseCollectionControls } = await import("./collection");
const { ReleasePassControls, VolumeReadCount } = await import("./reading");
type OverlayBook = import("./quickActions").OverlayBook;
type SeriesOverlay = import("./quickActions").SeriesOverlay;

type Host = { type: string; props: { children?: ReactNode } & Record<string, unknown> };

/** Expand function components into the host elements they render. */
function render(node: ReactNode): Host[] {
  if (Array.isArray(node)) return node.flatMap(render);
  if (!isValidElement(node)) return [];
  const { type, props } = node as ReactElement<Host["props"]>;
  if (typeof type === "function") {
    return render((type as (props: Host["props"]) => ReactNode)(props));
  }
  if (typeof type === "string") return [{ type, props }, ...render(props.children)];
  return render(props.children);
}

/** Render a root component with a fresh hook cursor (slots persist). */
function mount(component: () => ReactNode): Host[] {
  harness.cursor = 0;
  return render(component());
}

function text(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return text(node.props.children);
  return "";
}

function click(tree: Host[], label: string) {
  const button = tree.find((host) => host.type === "button" && text(host.props.children) === label);
  if (!button) throw new Error(`No button "${label}"`);
  (button.props.onClick as () => void)();
}

/**
 * Render a root component on its own hook slots (another control on the
 * page), leaving the current ones in place.
 */
function mountAside(slots: unknown[], component: () => ReactNode): Host[] {
  const current = harness.slots;
  harness.slots = slots;
  try {
    return mount(component);
  } finally {
    harness.slots = current;
  }
}

/** Press a button whether or not it renders disabled: a click the handler must refuse. */
function press(tree: Host[], label: string) {
  const button = tree.find((host) => host.type === "button" && text(host.props.children) === label);
  if (!button) throw new Error(`No button "${label}"`);
  const onClick = button.props.onClick as () => void;
  return { disabled: button.props.disabled === true, click: () => onClick() };
}

/**
 * Hold the `nth` call of one mutation, either just before it runs or just
 * after it commits (its response withheld): `reached` resolves at that
 * point, `release` lets it continue.
 */
function hold(name: string, nth: number, when: "before" | "after") {
  let release!: () => void;
  let reach!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const reached = new Promise<void>((resolve) => (reach = resolve));
  let calls = 0;
  harness.intercept = async (called, run) => {
    const held = called === name && ++calls === nth;
    if (held && when === "before") {
      reach();
      await gate;
    }
    const result = await run();
    if (held && when === "after") {
      reach();
      await gate;
    }
    return result;
  };
  return { reached, release };
}

/** Wait until every mutation the click chain starts (batches included) settles. */
async function settle() {
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (harness.inflight.length === 0) return;
    await Promise.allSettled(harness.inflight.splice(0));
  }
}

/** Like settle(), but leaves the first `held` in-flight calls alone. */
async function settleBesides(held: number) {
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const rest = harness.inflight.splice(held);
    if (rest.length === 0) return;
    await Promise.allSettled(rest);
  }
}

/** A Series of `count` single-Volume books, one physical Release each. */
async function seed(t: ReturnType<typeof convexTest>, count: number) {
  return await t.run(async (ctx) => {
    const publisherId = await ctx.db.insert("publishers", {
      status: "active",
      name: "Viz",
      slug: "viz",
    });
    const seriesId = await ctx.db.insert("series", {
      status: "active",
      publicId: 1,
      title: "One Piece",
      altTitles: [],
      searchText: "One Piece",
    });
    const books = [];
    for (let i = 0; i < count; i++) {
      const volumeId = await ctx.db.insert("volumes", {
        status: "active",
        publicId: 1000 + i,
        seriesId,
        position: i + 1,
        label: String(i + 1),
      });
      const editionId = await ctx.db.insert("editions", {
        status: "active",
        publicId: 5000 + i,
        publisherId,
      });
      await ctx.db.insert("volumeCoverages", {
        editionId,
        volumeId,
        order: 1,
        extent: "complete",
      });
      const releaseId = await ctx.db.insert("releases", {
        status: "active",
        editionId,
        format: "physical",
        binding: "paperback",
        language: "en",
        publisherId,
        seriesIds: [seriesId],
      });
      books.push({
        publicId: 5000 + i,
        releases: [{ id: releaseId as string, format: "physical" as const }],
        coverage: [{ volumePublicId: 1000 + i, extent: "complete" as const }],
      });
    }
    return { seriesId, books };
  });
}

/**
 * Another Edition of the same Series (an omnibus on another reading path)
 * covering the seeded Volumes at `positions` completely, with one Release.
 */
async function addOmnibus(t: ReturnType<typeof convexTest>, positions: number[]) {
  return await t.run(async (ctx) => {
    const publisher = (await ctx.db.query("publishers").first())!;
    const series = (await ctx.db.query("series").first())!;
    const editionId = await ctx.db.insert("editions", {
      status: "active",
      publicId: 9000,
      publisherId: publisher._id,
    });
    for (const [order, position] of positions.entries()) {
      const volume = (await ctx.db.query("volumes").collect()).find(
        (row) => row.position === position,
      )!;
      await ctx.db.insert("volumeCoverages", {
        editionId,
        volumeId: volume._id,
        order: order + 1,
        extent: "complete",
      });
    }
    const releaseId = await ctx.db.insert("releases", {
      status: "active",
      editionId,
      format: "physical",
      binding: "paperback",
      language: "en",
      publisherId: publisher._id,
      seriesIds: [series._id],
    });
    return {
      publicId: 9000,
      releases: [{ id: releaseId as string, format: "physical" as const }],
      coverage: positions.map((position) => ({
        volumePublicId: 999 + position,
        extent: "complete" as const,
      })),
    };
  });
}

async function signIn(t: ReturnType<typeof convexTest>) {
  const as = t.withIdentity({ subject: "user_2collector" });
  await as.mutation(api.users.claimUsername, { username: "collector" });
  harness.backend = as;
  return as;
}

/** Refresh the useQuery snapshot and read the overlay the way a shelf does. */
async function overlayFor(as: Backend) {
  harness.snapshot.set(
    getFunctionName(api.collection.seriesEntries),
    await as.query(api.collection.seriesEntries, { seriesPublicId: 1 }),
  );
  harness.snapshot.set(
    getFunctionName(api.reading.seriesTracking),
    await as.query(api.reading.seriesTracking, { seriesPublicId: 1 }),
  );
  const overlay = useSeriesOverlay(1);
  if (!overlay) throw new Error("overlay missing");
  return overlay;
}

beforeEach(() => {
  harness.backend = null;
  harness.intercept = null;
  harness.snapshot.clear();
  harness.inflight = [];
  harness.slots = [];
  harness.cursor = 0;
});

describe("BookQuickActions", () => {
  // B28: a state change from the cover must not drop the Variant the entry pins.
  it("keeps the pinned Variant when the cover changes the state", async () => {
    const t = convexTest(schema);
    const { books } = await seed(t, 1);
    const book = books[0]!;
    const releaseId = book.releases[0]!.id as Id<"releases">;
    const variantId = await t.run((ctx) =>
      ctx.db.insert("releaseVariants", { status: "active", releaseId, name: "Exclusive" }),
    );
    const as = await signIn(t);
    await as.mutation(api.collection.setReleaseEntry, { releaseId, state: "wanted", variantId });

    const quick = quickBookFor(book, await overlayFor(as));
    click(mount(() => BookQuickActions({ book: quick, onPrompt: () => undefined })), "Own");
    await settle();

    const entry = await as.query(api.collection.entryForRelease, { releaseId });
    expect(entry?.entry).toEqual({ state: "owned", variantId });
  });

  it("still removes the entry when the active state is clicked again", async () => {
    const t = convexTest(schema);
    const { books } = await seed(t, 1);
    const book = books[0]!;
    const releaseId = book.releases[0]!.id as Id<"releases">;
    const as = await signIn(t);
    await as.mutation(api.collection.setReleaseEntry, { releaseId, state: "owned" });

    const quick = quickBookFor(book, await overlayFor(as));
    click(mount(() => BookQuickActions({ book: quick, onPrompt: () => undefined })), "Own");
    await settle();

    const entry = await as.query(api.collection.entryForRelease, { releaseId });
    expect(entry?.entry).toBeNull();
  });
});

describe("RunActions", () => {
  it("batches at the backend caps", () => {
    expect(RUN_BATCH).toBe(MANY_ENTRIES_CAP);
    expect(RUN_BATCH).toBe(MANY_EDITIONS_CAP);
  });

  // B30: more applicable books than one mutation accepts.
  it("marks every book of a run longer than one batch", async () => {
    const t = convexTest(schema);
    const count = MANY_ENTRIES_CAP + 5;
    const { books } = await seed(t, count);
    const as = await signIn(t);
    const prompts: unknown[] = [];

    const overlay = await overlayFor(as);
    const run = () => RunActions({ books, overlay, onPrompt: (p) => prompts.push(p) });
    click(mount(run), "Own all");
    // The run reports its progress while the batches go out.
    const labels = mount(run).map((host) => text(host.props.children));
    expect(labels).toContain(`Marking 0 of ${count}…`);
    await settle();

    const owned = await t.run(async (ctx) =>
      (await ctx.db.query("collectionEntries").collect()).filter((e) => e.state === "owned"),
    );
    expect(owned).toHaveLength(count);
    // The first entry in the Series still raises its one follow prompt.
    expect(prompts).toHaveLength(1);
    expect(mount(run).some((host) => host.props.role === "alert")).toBe(false);
  });

  it("marks every book of a long run read", async () => {
    const t = convexTest(schema);
    const count = MANY_ENTRIES_CAP + 5;
    const { books } = await seed(t, count);
    const as = await signIn(t);

    const overlay = await overlayFor(as);
    click(mount(() => RunActions({ books, overlay, onPrompt: () => undefined })), "Read all");
    await settle();

    const read = await t.run(async (ctx) => await ctx.db.query("volumeProgress").collect());
    expect(read).toHaveLength(count);
  });

  it("shows the failure and how far it got when a batch is rejected", async () => {
    const t = convexTest(schema);
    const count = MANY_ENTRIES_CAP + 5;
    const { books } = await seed(t, count);
    const as = await signIn(t);
    const overlay = await overlayFor(as);
    // The last book vanishes from the catalog after the shelf loaded.
    await t.run(async (ctx) => {
      await ctx.db.delete(books[count - 1]!.releases[0]!.id as Id<"releases">);
    });

    const run = () => RunActions({ books, overlay, onPrompt: () => undefined });
    click(mount(run), "Own all");
    await settle();

    const alert = mount(run).find((host) => host.props.role === "alert");
    expect(alert).toBeDefined();
    expect(text(alert!.props.children)).toContain(`${MANY_ENTRIES_CAP} of ${count}`);
    expect(text(alert!.props.children)).toContain("Release not found.");
    // The buttons are usable again for a retry.
    const buttons = mount(run).filter((host) => host.type === "button");
    expect(buttons.some((host) => host.props.disabled === false)).toBe(true);
    // So is the cover of a book the stopped run never reached.
    expect(press(cover(books[count - 2]!, overlay), "Own").disabled).toBe(false);
  });
});

/** A book's cover controls, rendered against `overlay`. */
function cover(book: OverlayBook, overlay: SeriesOverlay) {
  const quick = quickBookFor(book, overlay);
  return mount(() => BookQuickActions({ book: quick, onPrompt: () => undefined }));
}

/** Press a button (a cover's or any control's); reports whether it went out as a write. */
function pressCover(tree: Host[], label: string) {
  const button = press(tree, label);
  const before = harness.inflight.length;
  button.click();
  return { disabled: button.disabled, accepted: harness.inflight.length > before };
}

// Review R17: a whole run's later batches must never overwrite a choice made
// on a cover (or by another run) while the run was still going.
describe("covers during a whole run", () => {
  const count = MANY_ENTRIES_CAP + 5;

  async function stateOf(as: Backend, book: { releases: ReadonlyArray<{ id: string }> }) {
    const releaseId = book.releases[0]!.id as Id<"releases">;
    return (await as.query(api.collection.entryForRelease, { releaseId }))?.entry?.state ?? null;
  }

  it("keeps a cover choice made while the first batch's response is outstanding", async () => {
    const t = convexTest(schema);
    const { books } = await seed(t, count);
    const as = await signIn(t);
    const overlay = await overlayFor(as);
    const first = hold("collection:setManyReleaseEntries", 1, "after");
    click(mount(() => RunActions({ books, overlay, onPrompt: () => undefined })), "Own all");
    await first.reached;

    // Book 205 still waits for the second batch.
    const last = books[count - 1]!;
    const want = pressCover(cover(last, await overlayFor(as)), "Want");
    await settleBesides(1);
    const chosen = await stateOf(as, last);
    first.release();
    await settle();

    // A choice the cover accepted is the newest one and must stand.
    if (want.accepted) expect(await stateOf(as, last)).toBe(chosen);
    // The cover was locked instead, and the run finished the book.
    expect(want).toEqual({ disabled: true, accepted: false });
    expect(await stateOf(as, last)).toBe("owned");
    // With the run over, the cover takes the choice and it stays.
    click(cover(last, await overlayFor(as)), "Want");
    await settle();
    expect(await stateOf(as, last)).toBe("wanted");
  });

  it("frees the covers of landed batches while later ones still wait", async () => {
    const t = convexTest(schema);
    const { books } = await seed(t, count);
    const as = await signIn(t);
    const overlay = await overlayFor(as);
    const second = hold("collection:setManyReleaseEntries", 2, "before");
    click(mount(() => RunActions({ books, overlay, onPrompt: () => undefined })), "Own all");
    await second.reached;

    const fresh = await overlayFor(as);
    const early = books[4]!;
    const last = books[count - 1]!;
    const earlyWant = pressCover(cover(early, fresh), "Want");
    const lastWant = pressCover(cover(last, fresh), "Want");
    await settleBesides(2);
    const chosenLast = await stateOf(as, last);
    second.release();
    await settle();

    if (lastWant.accepted) expect(await stateOf(as, last)).toBe(chosenLast);
    expect(lastWant).toEqual({ disabled: true, accepted: false });
    expect(earlyWant).toEqual({ disabled: false, accepted: true });
    expect(await stateOf(as, early)).toBe("wanted");
    expect(await stateOf(as, last)).toBe("owned");
  });

  it("keeps a read toggle made mid-run", async () => {
    const t = convexTest(schema);
    const { books } = await seed(t, count);
    const as = await signIn(t);
    const overlay = await overlayFor(as);
    const first = hold("reading:setEditionsRead", 1, "after");
    click(mount(() => RunActions({ books, overlay, onPrompt: () => undefined })), "Read all");
    await first.reached;

    // Mark book 205 read from its cover, then change your mind.
    const last = books[count - 1]!;
    const markRead = pressCover(cover(last, await overlayFor(as)), "Mark read");
    await settleBesides(1);
    const readNow = quickBookFor(last, await overlayFor(as)).read;
    const unmark = readNow
      ? pressCover(cover(last, await overlayFor(as)), "Read ✓")
      : { disabled: true, accepted: false };
    await settleBesides(1);
    const chosen = quickBookFor(last, await overlayFor(as)).read;
    first.release();
    await settle();

    if (markRead.accepted || unmark.accepted) {
      expect(quickBookFor(last, await overlayFor(as)).read).toBe(chosen);
    }
    expect(markRead).toEqual({ disabled: true, accepted: false });
    expect(quickBookFor(last, await overlayFor(as)).read).toBe(true);
  });

  it("refuses a second run over books the first has not finished", async () => {
    const t = convexTest(schema);
    const { books } = await seed(t, count);
    const as = await signIn(t);
    const overlay = await overlayFor(as);
    const first = hold("collection:setManyReleaseEntries", 1, "after");
    click(mount(() => RunActions({ books, overlay, onPrompt: () => undefined })), "Own all");
    await first.reached;

    // The same books on another shelf (a Release shelved under two Series),
    // with its own component state.
    const slots = harness.slots;
    harness.slots = [];
    const other = press(
      mount(() => RunActions({ books, overlay, onPrompt: () => undefined })),
      "Want all",
    );
    const before = harness.inflight.length;
    other.click();
    const accepted = harness.inflight.length > before;
    await settleBesides(1);
    harness.slots = slots;
    first.release();
    await settle();

    const states = await Promise.all(books.map((book) => stateOf(as, book)));
    if (accepted) expect(states.every((state) => state === "wanted")).toBe(true);
    expect({ disabled: other.disabled, accepted }).toEqual({ disabled: true, accepted: false });
    expect(states.every((state) => state === "owned")).toBe(true);
  });

  // Reading is per Volume: another Edition covering a Volume the run has yet
  // to mark writes that same Volume, so its cover waits for the run too.
  it("keeps a read toggle made on another Edition covering a waiting Volume", async () => {
    const t = convexTest(schema);
    const { books } = await seed(t, count);
    const omnibus = await addOmnibus(t, [count]);
    const as = await signIn(t);
    const overlay = await overlayFor(as);
    const first = hold("reading:setEditionsRead", 1, "after");
    click(mount(() => RunActions({ books, overlay, onPrompt: () => undefined })), "Read all");
    await first.reached;

    // Volume 205 waits for batch 2; mark it read through the omnibus, then unmark it.
    const markRead = pressCover(cover(omnibus, await overlayFor(as)), "Mark read");
    await settleBesides(1);
    const unmark = quickBookFor(omnibus, await overlayFor(as)).read
      ? pressCover(cover(omnibus, await overlayFor(as)), "Read ✓")
      : { disabled: true, accepted: false };
    await settleBesides(1);
    const chosen = quickBookFor(omnibus, await overlayFor(as)).read;
    first.release();
    await settle();

    if (markRead.accepted || unmark.accepted) {
      expect(quickBookFor(omnibus, await overlayFor(as)).read).toBe(chosen);
    }
    expect(markRead).toEqual({ disabled: true, accepted: false });
    expect(quickBookFor(omnibus, await overlayFor(as)).read).toBe(true);
    // With the run over, the omnibus cover is live again.
    expect(press(cover(omnibus, await overlayFor(as)), "Read ✓").disabled).toBe(false);
  });

  it("keeps a Volume claimed after one batch lands while a later batch still writes it", async () => {
    const t = convexTest(schema);
    const { books } = await seed(t, count);
    // First on the shelf, so batch 1 marks Volume 205 that batch 2's single also covers.
    const omnibus = await addOmnibus(t, [count]);
    const shelf = [omnibus, ...books];
    const as = await signIn(t);
    const overlay = await overlayFor(as);
    const second = hold("reading:setEditionsRead", 2, "before");
    click(mount(() => RunActions({ books: shelf, overlay, onPrompt: () => undefined })), "Read all");
    await second.reached;

    // Batch 1 already read Volume 205 through the omnibus; unmark it on the single.
    const last = books[count - 1]!;
    const fresh = await overlayFor(as);
    expect(quickBookFor(last, fresh).read).toBe(true);
    const unmark = pressCover(cover(last, fresh), "Read ✓");
    // A Volume only batch 1 wrote is free again.
    const early = pressCover(cover(books[4]!, fresh), "Read ✓");
    await settleBesides(2);
    const chosen = quickBookFor(last, await overlayFor(as)).read;
    second.release();
    await settle();

    if (unmark.accepted) expect(quickBookFor(last, await overlayFor(as)).read).toBe(chosen);
    expect(unmark).toEqual({ disabled: true, accepted: false });
    expect(early).toEqual({ disabled: false, accepted: true });
    expect(quickBookFor(last, await overlayFor(as)).read).toBe(true);
    expect(quickBookFor(books[4]!, await overlayFor(as)).read).toBe(false);
  });

  it("refuses a second Read all sharing a Volume the first has not marked", async () => {
    const t = convexTest(schema);
    const { books } = await seed(t, count);
    const omnibus = await addOmnibus(t, [count]);
    const as = await signIn(t);
    const overlay = await overlayFor(as);
    const first = hold("reading:setEditionsRead", 1, "after");
    click(mount(() => RunActions({ books, overlay, onPrompt: () => undefined })), "Read all");
    await first.reached;

    // The omnibus's own reading path, with its own component state.
    const slots = harness.slots;
    harness.slots = [];
    const other = press(
      mount(() => RunActions({ books: [omnibus], overlay, onPrompt: () => undefined })),
      "Read all",
    );
    const before = harness.inflight.length;
    other.click();
    const accepted = harness.inflight.length > before;
    await settleBesides(1);
    harness.slots = slots;
    first.release();
    await settle();

    expect({ disabled: other.disabled, accepted }).toEqual({ disabled: true, accepted: false });
    expect(quickBookFor(omnibus, await overlayFor(as)).read).toBe(true);
  });
});

/** Refresh the useQuery snapshot the way a Release row and Volume page read it. */
async function pageFor(as: Backend, releaseId: Id<"releases">) {
  harness.snapshot.set(
    getFunctionName(api.collection.entryForRelease),
    await as.query(api.collection.entryForRelease, { releaseId }),
  );
  harness.snapshot.set(
    getFunctionName(api.reading.passForRelease),
    await as.query(api.reading.passForRelease, { releaseId }),
  );
  harness.snapshot.set(
    getFunctionName(api.reading.seriesTracking),
    await as.query(api.reading.seriesTracking, { seriesPublicId: 1 }),
  );
}

// Review R17, second pass: the controls on the Release, Volume and Edition
// pages write the same entries and Volume Progress as a run, so they wait
// for it too — the run keeps going after the viewer follows a cover there.
describe("catalog-page controls during a whole run", () => {
  const count = MANY_ENTRIES_CAP + 5;

  it("locks a Release row's states and Variant until the run writes it", async () => {
    const t = convexTest(schema);
    const { books } = await seed(t, count);
    const releaseId = books[count - 1]!.releases[0]!.id as Id<"releases">;
    const variantId = await t.run((ctx) =>
      ctx.db.insert("releaseVariants", { status: "active", releaseId, name: "Exclusive" }),
    );
    const as = await signIn(t);
    await as.mutation(api.collection.setReleaseEntry, { releaseId, state: "wanted" });
    const overlay = await overlayFor(as);
    const first = hold("collection:setManyReleaseEntries", 1, "after");
    click(mount(() => RunActions({ books, overlay, onPrompt: () => undefined })), "Own all");
    await first.reached;

    // Book 205's Edition page, while batch 2 still waits.
    await pageFor(as, releaseId);
    const row = mountAside([], () => ReleaseCollectionControls({ releaseId }));
    const ordered = pressCover(row, "Ordered");
    const select = row.find((host) => host.type === "select")!;
    const before = harness.inflight.length;
    (select.props.onChange as (event: { currentTarget: { value: string } }) => void)({
      currentTarget: { value: variantId },
    });
    const pinned = { disabled: select.props.disabled, accepted: harness.inflight.length > before };
    await settleBesides(1);
    first.release();
    await settle();

    expect(ordered).toEqual({ disabled: true, accepted: false });
    expect(pinned).toEqual({ disabled: true, accepted: false });
    const entry = async () =>
      (await as.query(api.collection.entryForRelease, { releaseId }))?.entry;
    expect(await entry()).toEqual({ state: "owned", variantId: null });

    // With the run over, the row takes the choice and it stays.
    await pageFor(as, releaseId);
    const row2 = mountAside([], () => ReleaseCollectionControls({ releaseId }));
    expect(pressCover(row2, "Wanted")).toEqual({ disabled: false, accepted: true });
    await settle();
    expect((await entry())?.state).toBe("wanted");
  });

  it("locks a Volume's read count until the run marks it", async () => {
    const t = convexTest(schema);
    const { books } = await seed(t, count);
    const releaseId = books[count - 1]!.releases[0]!.id as Id<"releases">;
    const as = await signIn(t);
    const overlay = await overlayFor(as);
    const first = hold("reading:setEditionsRead", 1, "after");
    click(mount(() => RunActions({ books, overlay, onPrompt: () => undefined })), "Read all");
    await first.reached;

    // Volume 205's page: Mark read, then −1, while batch 2 still waits.
    const volumePublicId = 1000 + count - 1;
    const readCount = async () =>
      (await as.query(api.reading.seriesTracking, { seriesPublicId: 1 }))!.volumes.find(
        (row) => row.volumePublicId === volumePublicId,
      )!.readCount;
    const volume = () =>
      mountAside([], () => VolumeReadCount({ seriesPublicId: 1, volumePublicId }));
    await pageFor(as, releaseId);
    const markRead = pressCover(volume(), "Mark read");
    await settleBesides(1);
    await pageFor(as, releaseId);
    const takeBack = (await readCount()) > 0 ? pressCover(volume(), "−1") : null;
    await settleBesides(1);
    first.release();
    await settle();

    expect(markRead).toEqual({ disabled: true, accepted: false });
    expect(takeBack).toBeNull();
    expect(await readCount()).toBe(1);

    // With the run over, the count is live again.
    await pageFor(as, releaseId);
    expect(pressCover(volume(), "−1")).toEqual({ disabled: false, accepted: true });
    await settle();
    expect(await readCount()).toBe(0);
  });

  it("holds pass completion and its undo while a Read all is marking", async () => {
    const t = convexTest(schema);
    const { books } = await seed(t, count);
    const releaseId = books[count - 1]!.releases[0]!.id as Id<"releases">;
    const as = await signIn(t);
    await as.mutation(api.reading.startPass, { releaseId });
    await pageFor(as, releaseId);
    const pass: unknown[] = [];
    const controls = () => mountAside(pass, () => ReleasePassControls({ releaseId }));
    click(controls(), "Finished…");

    const overlay = await overlayFor(as);
    const first = hold("reading:setEditionsRead", 1, "after");
    click(mount(() => RunActions({ books, overlay, onPrompt: () => undefined })), "Read all");
    await first.reached;

    // Completing now would +1 a Volume batch 2 has yet to mark.
    const complete = pressCover(controls(), "Complete pass");
    await settleBesides(1);
    first.release();
    await settle();
    expect(complete).toEqual({ disabled: true, accepted: false });

    // After the run: complete, then a second run (book 1 unread again) holds the undo.
    click(controls(), "Complete pass");
    await settle();
    await pageFor(as, releaseId);
    expect(press(controls(), "Undo").disabled).toBe(false);
    await as.mutation(api.reading.setEditionRead, { editionPublicId: 5000, read: false });
    const unread = await overlayFor(as);
    const again = hold("reading:setEditionsRead", 1, "after");
    const other = () =>
      RunActions({ books: [books[0]!], overlay: unread, onPrompt: () => undefined });
    click(mountAside([], other), "Read all");
    await again.reached;
    const undo = pressCover(controls(), "Undo");
    await settleBesides(1);
    again.release();
    await settle();
    expect(undo).toEqual({ disabled: true, accepted: false });
    expect(press(controls(), "Undo").disabled).toBe(false);
  });
});
