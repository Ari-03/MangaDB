import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// `env.COVERS` is set per test; `waitUntil` collects background work.
const worker = vi.hoisted(() => ({
  env: {} as { COVERS?: unknown },
  background: [] as Promise<unknown>[],
}));
vi.mock("cloudflare:workers", () => ({
  env: worker.env,
  waitUntil: (promise: Promise<unknown>) => void worker.background.push(promise),
}));
const { coverResponse } = await import("./covers");

// A real-sized jacket (JPEG magic + padding) and the no-art answers.
const JACKET = new Uint8Array(20_000).fill(7);
JACKET.set([0xff, 0xd8, 0xff]);
const image = () => new Response(JACKET, { headers: { "Content-Type": "image/jpeg" } });
const status = (code: number) => () => new Response("x", { status: code });

let upstreams: Array<() => Response>;
beforeEach(() => {
  vi.stubGlobal("caches", { default: { match: async () => undefined, put: async () => {} } });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => (upstreams.shift() ?? status(404))()),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete worker.env.COVERS;
  worker.background.length = 0;
});

const get = () => coverResponse(new Request("https://mangadb.org/covers/9781974700523.jpg"));

describe("coverResponse", () => {
  test("ignores every other path", async () => {
    expect(await coverResponse(new Request("https://mangadb.org/series"))).toBeNull();
  });

  test("falls through a miss to the next upstream", async () => {
    upstreams = [status(404), image];
    const res = await get();
    expect(res?.status).toBe(200);
    expect(res?.headers.get("X-Cover-Origin")).toBe("upstream");
  });

  test("a miss everywhere is remembered for a day", async () => {
    upstreams = [status(404), status(404)];
    const res = await get();
    expect(res?.status).toBe(404);
    expect(res?.headers.get("Cache-Control")).toContain(`max-age=${60 * 60 * 24}`);
  });

  test("a rate-limited upstream makes it a short-lived miss", async () => {
    // OpenLibrary answers 403 past its per-IP ISBN lookup limit.
    upstreams = [status(404), status(403)];
    const res = await get();
    expect(res?.status).toBe(503);
    expect(res?.headers.get("Cache-Control")).toContain("max-age=300");
  });

  test("serves fetched art even when the R2 write fails", async () => {
    worker.env.COVERS = {
      get: async () => null,
      put: async () => {
        throw new Error("R2 unavailable");
      },
    };
    upstreams = [image];
    const res = await get();
    expect(res?.status).toBe(200);
    expect((await res!.arrayBuffer()).byteLength).toBe(JACKET.byteLength);
    // The failed write is settled in the background, never rethrown.
    await Promise.all(worker.background);
  });

  test("a body that breaks mid-read falls through to the next upstream", async () => {
    const broken = () =>
      new Response(
        new ReadableStream({
          start: (c) => {
            c.enqueue(new Uint8Array([0xff, 0xd8]));
            c.error(new Error("connection reset"));
          },
        }),
        { headers: { "Content-Type": "image/jpeg" } },
      );
    upstreams = [broken, image];
    const res = await get();
    expect(res?.status).toBe(200);
    expect(res?.headers.get("X-Cover-Origin")).toBe("upstream");
  });

  test("a body that breaks everywhere is a short-lived miss", async () => {
    const broken = () =>
      new Response(
        new ReadableStream({ start: (c) => c.error(new Error("connection reset")) }),
        { headers: { "Content-Type": "image/jpeg" } },
      );
    upstreams = [broken, status(404)];
    const res = await get();
    expect(res?.status).toBe(503);
  });

  test("serves the response even when the edge-cache write fails", async () => {
    vi.stubGlobal("caches", {
      default: {
        match: async () => undefined,
        put: async () => {
          throw new Error("cache write failed");
        },
      },
    });
    upstreams = [image];
    expect((await get())?.status).toBe(200);
    await Promise.all(worker.background);
  });

  test("an R2 read failure falls through to the upstreams", async () => {
    worker.env.COVERS = {
      get: async () => {
        throw new Error("R2 unavailable");
      },
      put: async () => {},
    };
    upstreams = [image];
    const res = await get();
    expect(res?.status).toBe(200);
    expect(res?.headers.get("X-Cover-Origin")).toBe("upstream");
  });
});
