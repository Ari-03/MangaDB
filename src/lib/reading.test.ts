// The per-Volume read-count controls and a Release row's pass controls,
// driven against convex-test: the components run as plain functions with
// convex/react's hooks wired to the test backend (test.react.ts). useQuery
// answers from a fixed snapshot, which is exactly the window between a
// click and the subscription refresh.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import {
  insertCoverage,
  insertEdition,
  insertPublisher,
  insertRelease,
  insertSeries,
  insertVolume,
} from "../../convex/test.factories";
import { makeT, reader, withUser, type Accessor, type TestT } from "../../convex/test.helpers";
import { click, harness, hold, mount, press, render, resetHarness, setQuery, settle, text, type Host } from "./test.react";

vi.mock("convex/react", async () => (await import("./test.react")).backendHooks);
vi.mock("~/lib/analytics", () => ({ track: () => undefined }));
vi.mock("~/lib/mature", () => ({ useArtConcealed: () => false }));

const { ReleasePassControls, VolumeReadCount } = await import("./reading");

/** Vinland Saga (Series 1) with Volume 11. */
async function seed(t: TestT) {
  return await t.run(async (ctx) => {
    const seriesId = await insertSeries(ctx, { publicId: 1, title: "Vinland Saga" });
    return await insertVolume(ctx, { publicId: 11, seriesId });
  });
}

async function signIn(t: TestT) {
  harness.backend = await withUser(t, reader);
  return harness.backend;
}

/** Render the controls from the tracking query as it stands right now. */
async function renderNow(as: Accessor) {
  setQuery(api.reading.seriesTracking, await as.query(api.reading.seriesTracking, { seriesPublicId: 1 }));
  return render(VolumeReadCount({ seriesPublicId: 1, volumePublicId: 11 }));
}

async function readCount(t: TestT, volumeId: Id<"volumes">) {
  return await t.run(async (ctx) => {
    const rows = await ctx.db.query("volumeProgress").collect();
    return rows.find((row) => row.volumeId === volumeId)?.readCount ?? 0;
  });
}

beforeEach(resetHarness);

describe("VolumeReadCount", () => {
  // B31: clicks landing before the subscription refreshes must all count.
  it("counts every +1 click made before the count refreshes", async () => {
    const t = makeT();
    const volumeId = await seed(t);
    const as = await signIn(t);

    const markRead = press(await renderNow(as), "Mark read");
    markRead.click();
    markRead.click();
    await settle();
    expect(await readCount(t, volumeId)).toBe(2);

    const plusOne = press(await renderNow(as), "+1 read");
    plusOne.click();
    plusOne.click();
    plusOne.click();
    await settle();
    expect(await readCount(t, volumeId)).toBe(5);
  });

  it("counts every −1 click and stops at zero", async () => {
    const t = makeT();
    const volumeId = await seed(t);
    const as = await signIn(t);
    await as.mutation(api.reading.setVolumeReadCount, { volumeId, readCount: 3 });

    const minusOne = press(await renderNow(as), "Remove one completed read");
    minusOne.click();
    minusOne.click();
    await settle();
    expect(await readCount(t, volumeId)).toBe(1);

    const again = press(await renderNow(as), "Remove one completed read");
    again.click();
    again.click();
    await settle();
    expect(await readCount(t, volumeId)).toBe(0);
  });
});

/** A Release of Vinland Saga's Edition covering Volume 11 completely. */
async function seedRelease(t: TestT) {
  return await t.run(async (ctx) => {
    const seriesId = await insertSeries(ctx, { publicId: 1, title: "Vinland Saga" });
    const volumeId = await insertVolume(ctx, { publicId: 11, seriesId });
    const publisherId = await insertPublisher(ctx, { name: "Kodansha", slug: "kodansha" });
    const editionId = await insertEdition(ctx, { publicId: 500, publisherId });
    await insertCoverage(ctx, { editionId, volumeId });
    const releaseId = await insertRelease(ctx, { editionId, binding: "paperback", publisherId, seriesIds: [seriesId] });
    return { volumeId, releaseId };
  });
}

/** The alert a control renders, if any. */
function alertOf(tree: Host[]) {
  const alert = tree.find((host) => host.props.role === "alert");
  return alert ? text(alert.props.children) : null;
}

describe("ReleasePassControls", () => {
  it("shows a refused completion beside the controls and keeps them usable", async () => {
    const t = makeT();
    const { releaseId } = await seedRelease(t);
    const as = await signIn(t);
    await as.mutation(api.reading.startPass, { releaseId });
    setQuery(api.reading.passForRelease, await as.query(api.reading.passForRelease, { releaseId }));
    const controls = () => mount(() => ReleasePassControls({ releaseId }));
    click(controls(), "Finished…");

    // The pass was stopped in another tab; this one has not heard yet.
    await as.mutation(api.reading.cancelPass, { releaseId });
    click(controls(), "Complete pass");
    await settle();

    const after = controls();
    expect(alertOf(after)).toBe("No active reading pass.");
    expect(press(after, "Finished…").disabled).toBe(false);
    expect(() => press(after, "Complete pass")).toThrow();

    // Refreshed, the row offers a new pass, and starting one clears the message.
    setQuery(api.reading.passForRelease, await as.query(api.reading.passForRelease, { releaseId }));
    expect(alertOf(controls())).toBe("No active reading pass.");
    click(controls(), "Start reading");
    await settle();
    expect(alertOf(controls())).toBeNull();
  });

  it("does not submit a completion again while one is in flight", async () => {
    const t = makeT();
    const { volumeId, releaseId } = await seedRelease(t);
    const as = await signIn(t);
    await as.mutation(api.reading.startPass, { releaseId });
    setQuery(api.reading.passForRelease, await as.query(api.reading.passForRelease, { releaseId }));
    const controls = () => mount(() => ReleasePassControls({ releaseId }));
    click(controls(), "Finished…");

    const first = hold("reading:completePass", 1, "before");
    click(controls(), "Complete pass");
    await first.reached;
    const again = press(controls(), "Completing…");
    const before = harness.inflight.length;
    again.click();
    const accepted = harness.inflight.length > before;
    first.release();
    await settle();

    expect({ disabled: again.disabled, accepted }).toEqual({ disabled: true, accepted: false });
    expect(await readCount(t, volumeId)).toBe(1);
    setQuery(api.reading.passForRelease, await as.query(api.reading.passForRelease, { releaseId }));
    expect(press(controls(), "Undo").disabled).toBe(false);
  });
});
