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
// snapshot useQuery answers from, the in-flight mutation promises, and the
// hook slots of the component being rendered.
const harness = vi.hoisted(() => ({
  backend: null as Backend | null,
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
        const call = harness.backend!.mutation(ref, args);
        harness.inflight.push(call);
        return call;
      },
  };
});

// useState backed by slots that survive re-renders of the same component.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  function useState<S>(initial: S | (() => S)) {
    const index = harness.cursor++;
    if (!(index in harness.slots)) {
      harness.slots[index] =
        typeof initial === "function" ? (initial as () => S)() : initial;
    }
    const set = (next: S | ((prev: S) => S)) => {
      harness.slots[index] =
        typeof next === "function"
          ? (next as (prev: S) => S)(harness.slots[index] as S)
          : next;
    };
    return [harness.slots[index] as S, set] as const;
  }
  return { ...actual, useState };
});

vi.mock("~/providers", () => ({ convexClient: {} }));
vi.mock("~/lib/analytics", () => ({ track: () => undefined }));
vi.mock("~/lib/mature", () => ({ useArtConcealed: () => false }));

const { BookQuickActions, RUN_BATCH, RunActions, quickBookFor, useSeriesOverlay } =
  await import("./quickActions");

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

/** Wait until every mutation the click chain starts (batches included) settles. */
async function settle() {
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (harness.inflight.length === 0) return;
    await Promise.allSettled(harness.inflight.splice(0));
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
  });
});
