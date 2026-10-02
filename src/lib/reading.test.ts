// The per-Volume read-count controls, driven against convex-test: the
// component runs as a plain function with convex/react's hooks wired to the
// test backend (test.react.ts). useQuery answers from a fixed snapshot,
// which is exactly the window between a click and the subscription refresh.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { insertSeries, insertVolume } from "../../convex/test.factories";
import { makeT, reader, withUser, type Accessor, type TestT } from "../../convex/test.helpers";
import { harness, press, render, resetHarness, setQuery, settle } from "./test.react";

vi.mock("convex/react", async () => (await import("./test.react")).backendHooks);
vi.mock("~/providers", () => ({ convexClient: {} }));
vi.mock("~/lib/analytics", () => ({ track: () => undefined }));
vi.mock("~/lib/mature", () => ({ useArtConcealed: () => false }));

const { VolumeReadCount } = await import("./reading");

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
