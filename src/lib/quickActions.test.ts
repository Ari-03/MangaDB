// Cover quick actions and whole-run controls, driven end to end against
// convex-test: the components run as plain functions with convex/react's
// hooks wired straight to the test backend (test.react.ts), so a click
// writes through the real mutations and the assertions read the resulting
// rows.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { MANY_ENTRIES_CAP } from "../../convex/collection";
import { MANY_EDITIONS_CAP } from "../../convex/reading";
import {
  insertCoverage,
  insertEdition,
  insertPublisher,
  insertRelease,
  insertSeries,
  insertVariant,
  insertVolume,
} from "../../convex/test.factories";
import { makeT, withUser, type Accessor, type TestT } from "../../convex/test.helpers";
import {
  click,
  harness,
  hold,
  mount,
  mountAside,
  press,
  resetHarness,
  setQuery,
  settle,
  settleBesides,
  text,
  type Host,
} from "./test.react";

vi.mock("convex/react", async () => (await import("./test.react")).backendHooks);
vi.mock("@clerk/tanstack-react-start", async () => (await import("./test.react")).clerkHooks);
vi.mock("~/lib/analytics", () => ({ track: () => undefined }));
vi.mock("~/lib/mature", () => ({ useArtConcealed: () => false }));

const { BookQuickActions, RUN_BATCH, RunActions, quickBookFor, useSeriesOverlay } =
  await import("./quickActions");
const { ReleaseCollectionControls } = await import("./collection");
const { ReleasePassControls, VolumeReadCount } = await import("./reading");
type OverlayBook = import("./quickActions").OverlayBook;
type SeriesOverlay = import("./quickActions").SeriesOverlay;

/**
 * A Series (public id 1) of `count` single-Volume books, one physical
 * Release each: book i is Edition 5000 + i covering Volume 1000 + i, at
 * position i + 1.
 */
async function seed(t: TestT, count: number) {
  return await t.run(async (ctx) => {
    const publisherId = await insertPublisher(ctx, { name: "Viz", slug: "viz" });
    const seriesId = await insertSeries(ctx, { publicId: 1, title: "One Piece" });
    const books = [];
    for (let i = 0; i < count; i++) {
      const volumeId = await insertVolume(ctx, { publicId: 1000 + i, seriesId, position: i + 1 });
      const editionId = await insertEdition(ctx, { publicId: 5000 + i, publisherId });
      await insertCoverage(ctx, { editionId, volumeId });
      const releaseId = await insertRelease(ctx, { editionId, binding: "paperback", publisherId, seriesIds: [seriesId] });
      books.push({
        publicId: 5000 + i,
        releases: [{ id: releaseId, format: "physical" as const }],
        coverage: [{ volumePublicId: 1000 + i, extent: "complete" as const }],
      });
    }
    return { seriesId, books };
  });
}

/**
 * Another Edition of the same Series (an omnibus on another reading path,
 * public id 9000) covering the seeded Volumes at `positions` completely,
 * with one Release.
 */
async function addOmnibus(t: TestT, positions: number[]): Promise<OverlayBook> {
  return await t.run(async (ctx) => {
    const publisher = (await ctx.db.query("publishers").first())!;
    const series = (await ctx.db.query("series").first())!;
    const volumes = await ctx.db.query("volumes").collect();
    const editionId = await insertEdition(ctx, { publicId: 9000, publisherId: publisher._id });
    for (const [order, position] of positions.entries()) {
      const volume = volumes.find((row) => row.position === position)!;
      await insertCoverage(ctx, { editionId, volumeId: volume._id, order: order + 1 });
    }
    const releaseId = await insertRelease(ctx, {
      editionId,
      binding: "paperback",
      publisherId: publisher._id,
      seriesIds: [series._id],
    });
    return {
      publicId: 9000,
      releases: [{ id: releaseId, format: "physical" as const }],
      coverage: positions.map((position) => ({
        volumePublicId: 999 + position,
        extent: "complete" as const,
      })),
    };
  });
}

async function signIn(t: TestT) {
  harness.backend = await withUser(t, { subject: "user_2collector", username: "collector" });
  return harness.backend;
}

/** Refresh the useQuery snapshot and read the overlay the way a shelf does. */
async function overlayFor(as: Accessor) {
  setQuery(api.collection.seriesEntries, await as.query(api.collection.seriesEntries, { seriesPublicId: 1 }));
  setQuery(api.reading.seriesTracking, await as.query(api.reading.seriesTracking, { seriesPublicId: 1 }));
  const overlay = useSeriesOverlay(1);
  if (!overlay) throw new Error("overlay missing");
  return overlay;
}

/** A book's cover controls, rendered against `overlay`. */
function cover(book: OverlayBook, overlay: SeriesOverlay) {
  const quick = quickBookFor(book, overlay);
  return mount(() => BookQuickActions({ book: quick, onPrompt: () => undefined }));
}

/** The whole-run controls over `books`, ignoring prompts. */
function runActions(books: ReadonlyArray<OverlayBook>, overlay: SeriesOverlay) {
  return () => RunActions({ books, overlay, onPrompt: () => undefined });
}

/** Press a button (a cover's or any control's); reports whether it went out as a write. */
function attempt(tree: Host[], label: string) {
  const button = press(tree, label);
  const before = harness.inflight.length;
  button.click();
  return { disabled: button.disabled, accepted: harness.inflight.length > before };
}

/** A book's collection state. */
async function stateOf(as: Accessor, book: OverlayBook) {
  const releaseId = book.releases[0]!.id;
  return (await as.query(api.collection.entryForRelease, { releaseId }))?.entry?.state ?? null;
}

/** Whether a book's cover reads it as read. */
async function readOf(as: Accessor, book: OverlayBook) {
  return quickBookFor(book, await overlayFor(as)).read;
}

/**
 * The two kinds of whole run, as the tests drive them: the run's button and
 * the mutation its batches call; the cover button that would change what
 * the run writes while it runs, and what the book reads (`picture`) once the
 * run marked it; the cover button that changes it after the run, and what
 * it reads then.
 */
const KINDS = {
  entries: {
    run: "Own all",
    call: "collection:setManyReleaseEntries",
    during: "Want",
    marked: "owned",
    after: "Want",
    chosen: "wanted",
    picture: stateOf,
  },
  reads: {
    run: "Read all",
    call: "reading:setEditionsRead",
    during: "Mark read",
    marked: true,
    after: "Read ✓",
    chosen: false,
    picture: readOf,
  },
} as const;

beforeEach(resetHarness);

describe("BookQuickActions", () => {
  // B28: a state change from the cover must not drop the Variant the entry pins.
  it("keeps the pinned Variant when the cover changes the state", async () => {
    const t = makeT();
    const { books } = await seed(t, 1);
    const book = books[0]!;
    const releaseId = book.releases[0]!.id;
    const variantId = await t.run((ctx) => insertVariant(ctx, { releaseId, name: "Exclusive" }));
    const as = await signIn(t);
    await as.mutation(api.collection.setReleaseEntry, { releaseId, state: "wanted", variantId });

    click(cover(book, await overlayFor(as)), "Own");
    await settle();

    const entry = await as.query(api.collection.entryForRelease, { releaseId });
    expect(entry?.entry).toEqual({ state: "owned", variantId });
  });

  it("still removes the entry when the active state is clicked again", async () => {
    const t = makeT();
    const { books } = await seed(t, 1);
    const book = books[0]!;
    const releaseId = book.releases[0]!.id;
    const as = await signIn(t);
    await as.mutation(api.collection.setReleaseEntry, { releaseId, state: "owned" });

    click(cover(book, await overlayFor(as)), "Own");
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
    const t = makeT();
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
    const t = makeT();
    const count = MANY_ENTRIES_CAP + 5;
    const { books } = await seed(t, count);
    const as = await signIn(t);

    click(mount(runActions(books, await overlayFor(as))), "Read all");
    await settle();

    const read = await t.run(async (ctx) => await ctx.db.query("volumeProgress").collect());
    expect(read).toHaveLength(count);
  });

  it("shows the failure and how far it got when a batch is rejected", async () => {
    const t = makeT();
    const count = MANY_ENTRIES_CAP + 5;
    const { books } = await seed(t, count);
    const as = await signIn(t);
    const overlay = await overlayFor(as);
    // The last book vanishes from the catalog after the shelf loaded.
    await t.run(async (ctx) => {
      await ctx.db.delete(books[count - 1]!.releases[0]!.id);
    });

    const run = runActions(books, overlay);
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

// The claims every control locks on (RunClaims) live in a store outside
// React, read through useSyncExternalStore. The fake React reads its
// snapshot on each render, so this checks the subscription itself: a
// control re-renders only if the store tells its subscribers.
describe("the run claims store", () => {
  it("notifies its subscribers when a run claims and frees books, until they unsubscribe", async () => {
    const t = makeT();
    const { books } = await seed(t, 1);
    const as = await signIn(t);
    const book = books[0]!;
    const overlay = await overlayFor(as);
    // A cover subscribes through useRunLock.
    cover(book, overlay);
    const listener = vi.fn();
    const unsubscribe = harness.subscribe!(listener);

    const write = hold("collection:setManyReleaseEntries", 1, "after");
    click(mount(runActions(books, overlay)), "Own all");
    const onClaim = listener.mock.calls.length;
    await write.reached;
    const locked = press(cover(book, overlay), "Want").disabled;
    write.release();
    await settle();

    // Claiming the book notified at once, before the write went out, and
    // freeing it notified again.
    expect(onClaim).toBeGreaterThan(0);
    expect(locked).toBe(true);
    expect(listener.mock.calls.length).toBeGreaterThan(onClaim);
    expect(press(cover(book, await overlayFor(as)), "Want").disabled).toBe(false);

    unsubscribe();
    listener.mockClear();
    click(mount(runActions(books, await overlayFor(as))), "Want all");
    await settle();
    expect(await stateOf(as, book)).toBe("wanted");
    expect(listener).not.toHaveBeenCalled();
  });
});

// Review R17: a whole run's later batches must never overwrite a choice made
// on a cover (or by another run) while the run was still going.
describe("covers during a whole run", () => {
  const count = MANY_ENTRIES_CAP + 5;

  it.each([KINDS.entries, KINDS.reads])(
    "refuses a cover's $during while the first batch of $run is outstanding, then takes it",
    async (kind) => {
      const t = makeT();
      const { books } = await seed(t, count);
      const as = await signIn(t);
      const first = hold(kind.call, 1, "after");
      click(mount(runActions(books, await overlayFor(as))), kind.run);
      await first.reached;

      // Book 205 still waits for the second batch.
      const last = books[count - 1]!;
      const during = attempt(cover(last, await overlayFor(as)), kind.during);
      await settleBesides(1);
      first.release();
      await settle();

      // The cover was locked, and the run finished the book.
      expect(during).toEqual({ disabled: true, accepted: false });
      expect(await kind.picture(as, last)).toBe(kind.marked);
      // With the run over, the cover takes the choice and it stays.
      click(cover(last, await overlayFor(as)), kind.after);
      await settle();
      expect(await kind.picture(as, last)).toBe(kind.chosen);
    },
  );

  it("frees the covers of landed batches while later ones still wait", async () => {
    const t = makeT();
    const { books } = await seed(t, count);
    const as = await signIn(t);
    const second = hold("collection:setManyReleaseEntries", 2, "before");
    click(mount(runActions(books, await overlayFor(as))), "Own all");
    await second.reached;

    const fresh = await overlayFor(as);
    const early = books[4]!;
    const last = books[count - 1]!;
    const earlyWant = attempt(cover(early, fresh), "Want");
    const lastWant = attempt(cover(last, fresh), "Want");
    await settleBesides(2);
    second.release();
    await settle();

    expect(lastWant).toEqual({ disabled: true, accepted: false });
    expect(earlyWant).toEqual({ disabled: false, accepted: true });
    expect(await stateOf(as, early)).toBe("wanted");
    expect(await stateOf(as, last)).toBe("owned");
  });

  it.each([
    // The same books on another shelf (a Release shelved under two Series).
    { ...KINDS.entries, second: "Want all", shelf: (books: OverlayBook[], _omnibus: OverlayBook) => books },
    // The omnibus's own reading path, sharing the run's Volume 205.
    { ...KINDS.reads, second: "Read all", shelf: (_books: OverlayBook[], omnibus: OverlayBook) => [omnibus] },
  ])("refuses a second $second over what a running $run has not finished", async ({ second, shelf, ...kind }) => {
    const t = makeT();
    const { books } = await seed(t, count);
    const omnibus = await addOmnibus(t, [count]);
    const as = await signIn(t);
    const overlay = await overlayFor(as);
    const first = hold(kind.call, 1, "after");
    click(mount(runActions(books, overlay)), kind.run);
    await first.reached;

    // The other run, with its own component state.
    const others = shelf(books, omnibus);
    const other = attempt(mountAside([], runActions(others, overlay)), second);
    await settleBesides(1);
    first.release();
    await settle();

    expect(other).toEqual({ disabled: true, accepted: false });
    // The first run's marks stand, and the refused run left no claim behind:
    // every cover is live again.
    const settled = await overlayFor(as);
    for (const book of others) {
      expect(await kind.picture(as, book)).toBe(kind.marked);
      expect(press(cover(book, settled), kind.after).disabled).toBe(false);
    }
  });

  // Reading is per Volume: another Edition covering a Volume the run has yet
  // to mark writes that same Volume, so its cover waits for the run too.
  it("refuses a read toggle on another Edition covering a waiting Volume", async () => {
    const t = makeT();
    const { books } = await seed(t, count);
    const omnibus = await addOmnibus(t, [count]);
    const as = await signIn(t);
    const first = hold("reading:setEditionsRead", 1, "after");
    click(mount(runActions(books, await overlayFor(as))), "Read all");
    await first.reached;

    // Volume 205 waits for batch 2; try to mark it read through the omnibus.
    const markRead = attempt(cover(omnibus, await overlayFor(as)), "Mark read");
    await settleBesides(1);
    first.release();
    await settle();

    expect(markRead).toEqual({ disabled: true, accepted: false });
    expect(await readOf(as, omnibus)).toBe(true);
    // With the run over, the omnibus cover is live again.
    expect(press(cover(omnibus, await overlayFor(as)), "Read ✓").disabled).toBe(false);
  });

  it("keeps a Volume claimed after one batch lands while a later batch still writes it", async () => {
    const t = makeT();
    const { books } = await seed(t, count);
    // First on the shelf, so batch 1 marks Volume 205 that batch 2's single also covers.
    const omnibus = await addOmnibus(t, [count]);
    const as = await signIn(t);
    const second = hold("reading:setEditionsRead", 2, "before");
    click(mount(runActions([omnibus, ...books], await overlayFor(as))), "Read all");
    await second.reached;

    // Batch 1 already read Volume 205 through the omnibus; unmark it on the single.
    const last = books[count - 1]!;
    const fresh = await overlayFor(as);
    expect(quickBookFor(last, fresh).read).toBe(true);
    const unmark = attempt(cover(last, fresh), "Read ✓");
    // A Volume only batch 1 wrote is free again.
    const early = attempt(cover(books[4]!, fresh), "Read ✓");
    await settleBesides(2);
    second.release();
    await settle();

    expect(unmark).toEqual({ disabled: true, accepted: false });
    expect(early).toEqual({ disabled: false, accepted: true });
    expect(await readOf(as, last)).toBe(true);
    expect(await readOf(as, books[4]!)).toBe(false);
  });
});

/** Refresh the useQuery snapshot the way a Release row and Volume page read it. */
async function pageFor(as: Accessor, releaseId: Id<"releases">) {
  setQuery(api.collection.entryForRelease, await as.query(api.collection.entryForRelease, { releaseId }));
  setQuery(api.reading.passForRelease, await as.query(api.reading.passForRelease, { releaseId }));
  setQuery(api.reading.seriesTracking, await as.query(api.reading.seriesTracking, { seriesPublicId: 1 }));
}

// Review R17, second pass: the controls on the Release, Volume and Edition
// pages write the same entries and Volume Progress as a run, so they wait
// for it too — the run keeps going after the viewer follows a cover there.
describe("catalog-page controls during a whole run", () => {
  const count = MANY_ENTRIES_CAP + 5;

  it("locks a Release row's states and Variant until the run writes it", async () => {
    const t = makeT();
    const { books } = await seed(t, count);
    const releaseId = books[count - 1]!.releases[0]!.id;
    const variantId = await t.run((ctx) => insertVariant(ctx, { releaseId, name: "Exclusive" }));
    const as = await signIn(t);
    await as.mutation(api.collection.setReleaseEntry, { releaseId, state: "wanted" });
    const first = hold("collection:setManyReleaseEntries", 1, "after");
    click(mount(runActions(books, await overlayFor(as))), "Own all");
    await first.reached;

    // Book 205's Edition page, while batch 2 still waits.
    await pageFor(as, releaseId);
    const row = mountAside([], () => ReleaseCollectionControls({ releaseId }));
    const ordered = attempt(row, "Ordered");
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
    expect(attempt(row2, "Wanted")).toEqual({ disabled: false, accepted: true });
    await settle();
    expect((await entry())?.state).toBe("wanted");
  });

  it("locks a Volume's read count until the run marks it", async () => {
    const t = makeT();
    const { books } = await seed(t, count);
    const releaseId = books[count - 1]!.releases[0]!.id;
    const as = await signIn(t);
    const first = hold("reading:setEditionsRead", 1, "after");
    click(mount(runActions(books, await overlayFor(as))), "Read all");
    await first.reached;

    // Volume 205's page: Mark read while batch 2 still waits.
    const volumePublicId = 1000 + count - 1;
    const readCount = async () =>
      (await as.query(api.reading.seriesTracking, { seriesPublicId: 1 }))!.volumes.find(
        (row) => row.volumePublicId === volumePublicId,
      )!.readCount;
    const volume = () =>
      mountAside([], () => VolumeReadCount({ seriesPublicId: 1, volumePublicId }));
    await pageFor(as, releaseId);
    const markRead = attempt(volume(), "Mark read");
    await settleBesides(1);
    // Refused, so there is no read to take back while the run is out.
    expect(await readCount()).toBe(0);
    first.release();
    await settle();

    expect(markRead).toEqual({ disabled: true, accepted: false });
    expect(await readCount()).toBe(1);

    // With the run over, the count is live again.
    await pageFor(as, releaseId);
    expect(attempt(volume(), "−1")).toEqual({ disabled: false, accepted: true });
    await settle();
    expect(await readCount()).toBe(0);
  });

  it("holds pass completion and its undo while a Read all is marking", async () => {
    const t = makeT();
    const { books } = await seed(t, count);
    const releaseId = books[count - 1]!.releases[0]!.id;
    const as = await signIn(t);
    await as.mutation(api.reading.startPass, { releaseId });
    await pageFor(as, releaseId);
    const pass: unknown[] = [];
    const controls = () => mountAside(pass, () => ReleasePassControls({ releaseId }));
    click(controls(), "Finished…");

    const first = hold("reading:setEditionsRead", 1, "after");
    click(mount(runActions(books, await overlayFor(as))), "Read all");
    await first.reached;

    // Completing now would +1 a Volume batch 2 has yet to mark.
    const complete = attempt(controls(), "Complete pass");
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
    const again = hold("reading:setEditionsRead", 1, "after");
    click(mountAside([], runActions([books[0]!], await overlayFor(as))), "Read all");
    await again.reached;
    const undo = attempt(controls(), "Undo");
    await settleBesides(1);
    again.release();
    await settle();
    expect(undo).toEqual({ disabled: true, accepted: false });
    expect(press(controls(), "Undo").disabled).toBe(false);
  });
});

/**
 * Two overlapping runs of `name`, as the calls reach the backend: call 2 is
 * run A's second batch, held before it runs (and rejected once released if
 * `fail`); call 3 is run B's first batch, held after it commits. The three
 * stay first in harness.inflight, so settleBesides(3) leaves B held.
 */
function overlapCalls(name: string, fail = false) {
  let releaseA!: () => void;
  let releaseB!: () => void;
  let reachA!: () => void;
  let reachB!: () => void;
  const gateA = new Promise<void>((resolve) => (releaseA = resolve));
  const gateB = new Promise<void>((resolve) => (releaseB = resolve));
  const reachedA = new Promise<void>((resolve) => (reachA = resolve));
  const reachedB = new Promise<void>((resolve) => (reachB = resolve));
  let calls = 0;
  harness.intercept = async (called, run) => {
    if (called !== name) return await run();
    const call = ++calls;
    if (call === 2) {
      reachA();
      await gateA;
      if (fail) throw new Error("offline");
    }
    const result = await run();
    if (call === 3) {
      reachB();
      await gateB;
    }
    return result;
  };
  return { reachedA, releaseA, reachedB, releaseB };
}

// Review W06: run A frees book 5 once its first batch lands, run B then
// claims it for B's last batch; A finishing (or failing) must not free it.
// Two 409-book runs take a few seconds, more under a loaded full-suite run.
describe("overlapping whole runs", { timeout: 30_000 }, () => {
  const count = 2 * MANY_ENTRIES_CAP + 9;

  /**
   * Run B's button for each kind; the cover button B's claim on book 5
   * locks; what book 5 reads while B holds it and once B lands; and how
   * book 5 is made pending for B after A's first batch marked it (an entry
   * run B changes the state, a Read all needs the book unread again).
   */
  const OVERLAPS = {
    entries: { ...KINDS.entries, b: "Want all", cover: "Order", held: "owned", landed: "wanted", reopen: null },
    reads: {
      ...KINDS.reads,
      b: "Read all",
      cover: "Mark read",
      held: false,
      landed: true,
      reopen: (as: Accessor, book: OverlayBook) =>
        as.mutation(api.reading.setEditionRead, { editionPublicId: book.publicId, read: false }),
    },
  } as const;

  /** A over books 1–205, then B over 206–409 plus book 5 once A's batch 1 lands. */
  async function overlapping(overlap: (typeof OVERLAPS)[keyof typeof OVERLAPS], fail = false) {
    const t = makeT();
    const { books } = await seed(t, count);
    const as = await signIn(t);
    const shared = books[4]!;
    const runs = overlapCalls(overlap.call, fail);
    const aSlots: unknown[] = [];
    const runA = runActions(books.slice(0, 205), await overlayFor(as));
    click(mountAside(aSlots, runA), overlap.run);
    await runs.reachedA;
    await overlap.reopen?.(as, shared);
    click(mountAside([], runActions([...books.slice(205), shared], await overlayFor(as))), overlap.b);
    await runs.reachedB;
    // B holds book 5 for its last batch.
    expect(press(cover(shared, await overlayFor(as)), overlap.cover).disabled).toBe(true);

    runs.releaseA();
    await vi.waitFor(() => expect(aSlots[0]).toBeNull(), { timeout: 10_000 });
    const pressed = attempt(cover(shared, await overlayFor(as)), overlap.cover);
    await settleBesides(3);
    const meanwhile = await overlap.picture(as, shared);
    runs.releaseB();
    await settle();

    // A's end left book 5 to B: its cover stayed locked, and B wrote it.
    expect({ pressed, meanwhile }).toEqual({
      pressed: { disabled: true, accepted: false },
      meanwhile: overlap.held,
    });
    expect(await overlap.picture(as, shared)).toBe(overlap.landed);
    const alert = mountAside(aSlots, runA).find((host) => host.props.role === "alert");
    return { as, books, alert };
  }

  it.each([OVERLAPS.entries, OVERLAPS.reads])("a finishing $run frees only the claims it still holds", async (overlap) => {
    const { alert } = await overlapping(overlap);
    expect(alert).toBeUndefined();
  });

  it("a run that fails mid-way frees only what it still holds", async () => {
    const { as, books, alert } = await overlapping(OVERLAPS.entries, true);
    expect(text(alert?.props.children)).toContain("Marked 200 of 205");
    // A's unlanded tail, never claimed by B, is free again.
    const settled = await overlayFor(as);
    const tail = books.slice(200, 205);
    expect(tail.map((book) => press(cover(book, settled), "Own").disabled)).toEqual(
      tail.map(() => false),
    );
  });

  // Two clicks before a re-render: the second run is refused and leaves no claim.
  it("refuses a repeated click on the same run and frees everything after", async () => {
    const t = makeT();
    const { books } = await seed(t, 3);
    const as = await signIn(t);
    const tree = mount(runActions(books, await overlayFor(as)));
    click(tree, "Own all");
    const again = attempt(tree, "Own all");
    await settle();

    expect(again.accepted).toBe(false);
    expect(await Promise.all(books.map((book) => stateOf(as, book)))).toEqual(
      books.map(() => "owned"),
    );
    const settled = await overlayFor(as);
    expect(books.map((book) => press(cover(book, settled), "Want").disabled)).toEqual(
      books.map(() => false),
    );
  });
});
