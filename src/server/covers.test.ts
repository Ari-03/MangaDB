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
const { coverResponse, coversOnFile } = await import("./covers");

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

describe("coverResponse with a failing edge cache", () => {
  test("a failed cache read is a miss: the art is still served", async () => {
    vi.stubGlobal("caches", {
      default: {
        match: async () => {
          throw new Error("cache read failed");
        },
        put: async () => {},
      },
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    upstreams = [image];
    const res = await get();
    expect(res?.status).toBe(200);
    expect(res?.headers.get("X-Cover-Origin")).toBe("upstream");
    errors.mockRestore();
  });
});

describe("coversOnFile", () => {
  const ORIGIN = "https://mangadb.org";
  // Each test uses its own ISBNs: the module remembers what it learned.
  const isbn = (n: number) => `9781974${String(n).padStart(6, "0")}`;
  /** An R2 bucket holding jackets for `held`, counting its head reads. */
  const bucket = (held: Array<string>) => {
    const keys = new Set(held.map((value) => `${value}.jpg`));
    const head = vi.fn(async (key: string) => (keys.has(key) ? {} : null));
    return { head, get: vi.fn(async () => null), put: vi.fn(async () => {}) };
  };

  test("says nothing when no bucket is bound", async () => {
    expect(await coversOnFile([{ need: 2, candidates: [isbn(1)] }], ORIGIN)).toBeNull();
  });

  test("returns the candidates whose jacket R2 holds", async () => {
    worker.env.COVERS = bucket([isbn(10), isbn(12)]);
    const shelf = { need: 3, candidates: [isbn(10), isbn(11), isbn(12)] };
    expect(await coversOnFile([shelf], ORIGIN)).toEqual([isbn(10), isbn(12)]);
  });

  test("stops reading once a shelf's seats are filled", async () => {
    const covers = bucket([isbn(20), isbn(21), isbn(22), isbn(23)]);
    worker.env.COVERS = covers;
    const shelf = { need: 2, candidates: [isbn(20), isbn(21), isbn(22), isbn(23)] };
    expect(await coversOnFile([shelf], ORIGIN)).toEqual([isbn(20), isbn(21)]);
    expect(covers.head).toHaveBeenCalledTimes(2);
  });

  test("reads on past a missing jacket, one read per empty seat", async () => {
    const covers = bucket([isbn(30), isbn(32)]);
    worker.env.COVERS = covers;
    const shelf = { need: 2, candidates: [isbn(30), isbn(31), isbn(32), isbn(33)] };
    expect(await coversOnFile([shelf], ORIGIN)).toEqual([isbn(30), isbn(32)]);
    expect(covers.head).toHaveBeenCalledTimes(3);
  });

  test("publisher art takes a seat without a read", async () => {
    const covers = bucket([isbn(40), isbn(41)]);
    worker.env.COVERS = covers;
    const shelf = { need: 2, candidates: [null, isbn(40), isbn(41)] };
    expect(await coversOnFile([shelf], ORIGIN)).toEqual([isbn(40)]);
    expect(covers.head).toHaveBeenCalledTimes(1);
  });

  test("remembers what it learned, so a second ask reads nothing", async () => {
    const covers = bucket([isbn(50)]);
    worker.env.COVERS = covers;
    const shelf = { need: 2, candidates: [isbn(50), isbn(51)] };
    await coversOnFile([shelf], ORIGIN);
    expect(await coversOnFile([shelf], ORIGIN)).toEqual([isbn(50)]);
    expect(covers.head).toHaveBeenCalledTimes(2);
  });

  test("never turns a non-ISBN candidate into an R2 key", async () => {
    const covers = bucket([]);
    worker.env.COVERS = covers;
    const shelf = { need: 2, candidates: ["../secrets", "9781974", isbn(60)] };
    expect(await coversOnFile([shelf], ORIGIN)).toEqual([]);
    expect(covers.head.mock.calls.map(([key]) => key)).toEqual([`${isbn(60)}.jpg`]);
  });

  test("fetches an absent jacket in the background for the next visitor", async () => {
    const covers = bucket([]);
    worker.env.COVERS = covers;
    upstreams = [image];
    expect(await coversOnFile([{ need: 1, candidates: [isbn(70)] }], ORIGIN)).toEqual([]);
    await Promise.all(worker.background);
    await Promise.all(worker.background);
    expect(covers.put).toHaveBeenCalledWith(`${isbn(70)}.jpg`, expect.anything(), expect.anything());
  });

  test("a failed R2 read is no jacket, and is asked again next time", async () => {
    const covers = bucket([isbn(80)]);
    covers.head.mockRejectedValueOnce(new Error("r2 down"));
    worker.env.COVERS = covers;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const shelf = { need: 1, candidates: [isbn(80)] };
    expect(await coversOnFile([shelf], ORIGIN)).toEqual([]);
    expect(await coversOnFile([shelf], ORIGIN)).toEqual([isbn(80)]);
    errors.mockRestore();
  });
});
