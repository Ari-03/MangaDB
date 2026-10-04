import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { stubBrokenEdgeCache, stubEdgeCache } from "./test.cache";

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

let upstreams: Array<() => Response | Promise<Response>>;
let edge: Map<string, Response>;
beforeEach(() => {
  edge = stubEdgeCache();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => (upstreams.shift() ?? status(404))()),
  );
});
afterEach(async () => {
  // Settle background work first: a refresh holds its ISBN until it ends.
  await Promise.all(worker.background);
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
    stubBrokenEdgeCache("write");
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

describe("coverResponse with a stored jacket", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const PRH = "https://images.penguinrandomhouse.com/cover/9781974700523";
  const OPEN_LIBRARY = "https://covers.openlibrary.org/b/isbn/9781974700523-L.jpg?default=false";
  const OLD = new Uint8Array(30_000).fill(3);
  const daysAgo = (days: number) => new Date(Date.now() - days * DAY).toISOString();
  /** An R2 bucket holding OLD under the test ISBN with `metadata`, recording writes. */
  const stored = (metadata?: Record<string, string>) => {
    const covers = {
      get: vi.fn(async () => ({
        arrayBuffer: async () => OLD.slice().buffer,
        etag: "etag-1",
        httpMetadata: { contentType: "image/jpeg" },
        customMetadata: metadata,
      })),
      put: vi.fn(
        async (
          _key: string,
          _value: ArrayBuffer,
          _options: { customMetadata?: Record<string, string>; onlyIf?: object },
        ) => {},
      ),
    };
    worker.env.COVERS = covers;
    return covers;
  };
  const settle = async () => {
    await Promise.all(worker.background);
    await Promise.all(worker.background);
  };
  const fetches = () => vi.mocked(fetch).mock.calls.map(([url]) => String(url));
  const maxAge = (res: Response | undefined | null) =>
    Number(/max-age=(\d+)/.exec(res?.headers.get("Cache-Control") ?? "")?.[1]);
  /** The one write a refresh made: its bytes and metadata. */
  const written = (covers: ReturnType<typeof stored>) => {
    expect(covers.put).toHaveBeenCalledTimes(1);
    const [key, value, options] = covers.put.mock.calls[0]!;
    expect(key).toBe("9781974700523.jpg");
    return { bytes: new Uint8Array(value), ...options };
  };
  const recent = (iso: string | undefined) => Date.now() - Date.parse(iso ?? "") < 60_000;

  test("a fresh copy is served without asking any upstream", async () => {
    const covers = stored({ source: PRH, fetchedAt: daysAgo(10) });
    const res = await get();
    expect(res?.headers.get("X-Cover-Origin")).toBe("r2");
    await settle();
    expect(fetches()).toEqual([]);
    expect(covers.put).not.toHaveBeenCalled();
  });

  test("a fresh copy is cached no longer than the time left before its check", async () => {
    stored({ source: PRH, fetchedAt: daysAgo(80) });
    const res = await get();
    const left = 10 * 24 * 60 * 60;
    expect(maxAge(res)).toBeGreaterThan(left - 60);
    expect(maxAge(res)).toBeLessThanOrEqual(left);
    await settle();
    expect(maxAge(edge.get("https://mangadb.org/covers/9781974700523.jpg"))).toBe(maxAge(res));
  });

  test("a newly checked copy is cached for the usual 30 days", async () => {
    stored({ source: PRH, fetchedAt: daysAgo(200), checkedAt: daysAgo(1) });
    expect(maxAge(await get())).toBe(60 * 60 * 24 * 30);
  });

  test("an old copy is served at once, then replaced by real art in the background", async () => {
    const covers = stored({ source: PRH, fetchedAt: daysAgo(100) });
    let answer!: (response: Response) => void;
    upstreams = [() => new Promise<Response>((resolve) => (answer = resolve))];
    const res = await get();
    expect(res?.headers.get("X-Cover-Origin")).toBe("r2");
    expect(new Uint8Array(await res!.arrayBuffer())).toEqual(OLD);
    // Served with a short lifetime, at the edge as in the browser.
    expect(maxAge(res)).toBe(60 * 60);
    expect(covers.put).not.toHaveBeenCalled();
    answer(image());
    await settle();
    expect(maxAge(edge.get("https://mangadb.org/covers/9781974700523.jpg"))).toBe(60 * 60);
    expect(fetches()).toEqual([PRH]);
    const write = written(covers);
    expect(write.bytes).toEqual(JACKET);
    expect(write.customMetadata?.source).toBe(PRH);
    expect(recent(write.customMetadata?.fetchedAt)).toBe(true);
  });

  test("a copy with no readable timestamp counts as old", async () => {
    const unreadable: Array<Record<string, string> | undefined> = [
      undefined,
      { source: PRH },
      { source: PRH, fetchedAt: "soon" },
    ];
    for (const metadata of unreadable) {
      edge.clear();
      const covers = stored(metadata);
      upstreams = [image];
      expect(maxAge(await get())).toBe(60 * 60);
      await settle();
      expect(written(covers).bytes).toEqual(JACKET);
    }
  });

  test("the same art again still restarts the clock", async () => {
    const covers = stored({ source: PRH, fetchedAt: daysAgo(100) });
    upstreams = [() => new Response(OLD, { headers: { "Content-Type": "image/jpeg" } })];
    await get();
    await settle();
    const write = written(covers);
    expect(write.bytes).toEqual(OLD);
    expect(recent(write.customMetadata?.fetchedAt)).toBe(true);
  });

  test("art first found at OpenLibrary is replaced once the CDN has it", async () => {
    const covers = stored({ source: OPEN_LIBRARY, fetchedAt: daysAgo(100) });
    upstreams = [image];
    await get();
    await settle();
    expect(fetches()).toEqual([PRH]);
    expect(written(covers).customMetadata?.source).toBe(PRH);
  });

  test("art from the CDN is never traded for a lesser source's", async () => {
    const covers = stored({ source: PRH, fetchedAt: daysAgo(100) });
    upstreams = [status(503), image];
    await get();
    await settle();
    expect(fetches()).toEqual([PRH]);
    expect(written(covers).bytes).toEqual(OLD);
  });

  const placeholder = () =>
    new Response(new Uint8Array(100), { headers: { "Content-Type": "image/jpeg" } });
  test.each([
    ["a miss", status(404)],
    ["an outage", status(503)],
    ["a stand-in", placeholder],
  ])("%s upstream keeps the old art and records the check", async (_name, answer) => {
    const metadata = { source: OPEN_LIBRARY, fetchedAt: daysAgo(100) };
    const covers = stored(metadata);
    upstreams = [answer, answer];
    await get();
    await settle();
    const write = written(covers);
    expect(write.bytes).toEqual(OLD);
    expect(write.customMetadata).toMatchObject(metadata);
    expect(recent(write.customMetadata?.checkedAt)).toBe(true);
    // Lands only on the copy it read, never over a newer jacket.
    expect(write.onlyIf).toEqual({ etagMatches: "etag-1" });
  });

  test("two requests for the same old copy start one check", async () => {
    const covers = stored({ source: PRH, fetchedAt: daysAgo(100) });
    upstreams = [image, image];
    const both = await Promise.all([get(), get()]);
    expect(both.map((res) => res?.headers.get("X-Cover-Origin"))).toEqual(["r2", "r2"]);
    await settle();
    expect(fetches()).toEqual([PRH]);
    expect(covers.put).toHaveBeenCalledTimes(1);
  });

  test("only a few checks run at once in an isolate", async () => {
    const covers = stored({ source: PRH, fetchedAt: daysAgo(100) });
    const pending: Array<() => void> = [];
    vi.mocked(fetch).mockImplementation(
      () => new Promise<Response>((resolve) => pending.push(() => resolve(image()))),
    );
    await Promise.all(
      Array.from({ length: 6 }, (_, n) =>
        coverResponse(new Request(`https://mangadb.org/covers/97819747005${30 + n}.jpg`)),
      ),
    );
    expect(pending).toHaveLength(4);
    for (const resolve of pending) resolve();
    await settle();
    expect(covers.put).toHaveBeenCalledTimes(4);
  });
});

describe("coverResponse with a failing edge cache", () => {
  test("a failed cache read is a miss: the art is still served", async () => {
    stubBrokenEdgeCache("read");
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
