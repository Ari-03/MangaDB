// The per-Volume read-count controls, driven against convex-test: the
// component runs as a plain function with convex/react's hooks wired to the
// test backend. useQuery answers from a fixed snapshot, which is exactly the
// window between a click and the subscription refresh.

import { convexTest } from "convex-test";
import type { FunctionReference } from "convex/server";
import { getFunctionName } from "convex/server";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import schema from "../../convex/schema";

type Backend = ReturnType<ReturnType<typeof convexTest>["withIdentity"]>;

const harness = vi.hoisted(() => ({
  backend: null as Backend | null,
  snapshot: new Map<string, unknown>(),
  inflight: [] as Array<Promise<unknown>>,
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
vi.mock("~/providers", () => ({ convexClient: {} }));
vi.mock("~/lib/analytics", () => ({ track: () => undefined }));
vi.mock("~/lib/mature", () => ({ useArtConcealed: () => false }));

const { VolumeReadCount } = await import("./reading");

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

function text(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return text(node.props.children);
  return "";
}

function button(tree: Host[], label: string) {
  const found = tree.find(
    (host) =>
      host.type === "button" &&
      (text(host.props.children) === label || host.props["aria-label"] === label),
  );
  if (!found) throw new Error(`No button "${label}"`);
  return found.props.onClick as () => void;
}

async function settle() {
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (harness.inflight.length === 0) return;
    await Promise.allSettled(harness.inflight.splice(0));
  }
}

async function seed(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const seriesId = await ctx.db.insert("series", {
      status: "active",
      publicId: 1,
      title: "Vinland Saga",
      altTitles: [],
      searchText: "Vinland Saga",
    });
    return await ctx.db.insert("volumes", {
      status: "active",
      publicId: 11,
      seriesId,
      position: 1,
      label: "1",
    });
  });
}

async function signIn(t: ReturnType<typeof convexTest>) {
  const as = t.withIdentity({ subject: "user_2reader" });
  await as.mutation(api.users.claimUsername, { username: "reader" });
  harness.backend = as;
  return as;
}

/** Render the controls from the tracking query as it stands right now. */
async function renderNow(as: Backend) {
  harness.snapshot.set(
    getFunctionName(api.reading.seriesTracking),
    await as.query(api.reading.seriesTracking, { seriesPublicId: 1 }),
  );
  return render(VolumeReadCount({ seriesPublicId: 1, volumePublicId: 11 }));
}

async function readCount(t: ReturnType<typeof convexTest>, volumeId: Id<"volumes">) {
  return await t.run(async (ctx) => {
    const rows = await ctx.db.query("volumeProgress").collect();
    return rows.find((row) => row.volumeId === volumeId)?.readCount ?? 0;
  });
}

beforeEach(() => {
  harness.backend = null;
  harness.snapshot.clear();
  harness.inflight = [];
});

describe("VolumeReadCount", () => {
  // B31: clicks landing before the subscription refreshes must all count.
  it("counts every +1 click made before the count refreshes", async () => {
    const t = convexTest(schema);
    const volumeId = await seed(t);
    const as = await signIn(t);

    const markRead = button(await renderNow(as), "Mark read");
    markRead();
    markRead();
    await settle();
    expect(await readCount(t, volumeId)).toBe(2);

    const plusOne = button(await renderNow(as), "+1 read");
    plusOne();
    plusOne();
    plusOne();
    await settle();
    expect(await readCount(t, volumeId)).toBe(5);
  });

  it("counts every −1 click and stops at zero", async () => {
    const t = convexTest(schema);
    const volumeId = await seed(t);
    const as = await signIn(t);
    await as.mutation(api.reading.setVolumeReadCount, { volumeId, readCount: 3 });

    const minusOne = button(await renderNow(as), "Remove one completed read");
    minusOne();
    minusOne();
    await settle();
    expect(await readCount(t, volumeId)).toBe(1);

    const again = button(await renderNow(as), "Remove one completed read");
    again();
    again();
    await settle();
    expect(await readCount(t, volumeId)).toBe(0);
  });
});
