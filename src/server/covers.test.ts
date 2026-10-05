import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { CoverShelf } from "~/lib/homeShelves";

import { stubBrokenEdgeCache, stubEdgeCache } from "./test.cache";

// `env.COVERS` is set per test; `waitUntil` collects background work, or
// throws while `refuse` is set, as a runtime that will not own more work does.
const worker = vi.hoisted(() => ({
  env: {} as { COVERS?: unknown },
  background: [] as Promise<unknown>[],
  refuse: false,
}));
vi.mock("cloudflare:workers", () => ({
  env: worker.env,
  waitUntil: (promise: Promise<unknown>) => {
    if (worker.refuse) throw new Error("waitUntil refused");
    worker.background.push(promise);
  },
}));
const { coverResponse, coversOnFile } = await import("./covers");
const { timeRequest } = await import("./timing");

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
      new Response(new ReadableStream({ start: (c) => c.error(new Error("connection reset")) }), {
        headers: { "Content-Type": "image/jpeg" },
      });
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
        httpEtag: '"etag-1"',
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
    expect(write.onlyIf).toEqual({ etagMatches: "etag-1" });
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
    expect(covers.put).not.toHaveBeenCalled();
  });

  const placeholder = () =>
    new Response(new Uint8Array(100), { headers: { "Content-Type": "image/jpeg" } });
  test.each([
    ["a miss", status(404)],
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

  test("an outage records nothing, so the copy is checked again after its hour", async () => {
    const covers = stored({ source: OPEN_LIBRARY, fetchedAt: daysAgo(100) });
    upstreams = [status(503), status(403)];
    expect(maxAge(await get())).toBe(60 * 60);
    await settle();
    expect(covers.put).not.toHaveBeenCalled();
    // The hour is up: the next request finds the copy still due.
    edge.clear();
    upstreams = [image];
    expect(maxAge(await get())).toBe(60 * 60);
    await settle();
    expect(fetches()).toEqual([PRH, OPEN_LIBRARY, PRH]);
    expect(written(covers).bytes).toEqual(JACKET);
  });

  test("a check never overwrites a jacket another isolate stored meanwhile", async () => {
    // One object with R2's conditional write: each write gets a new etag.
    let object = { bytes: OLD, etag: "etag-1", source: OPEN_LIBRARY, fetchedAt: daysAgo(100) };
    let writes = 1;
    worker.env.COVERS = {
      get: async () => ({
        arrayBuffer: async () => object.bytes.slice().buffer,
        etag: object.etag,
        httpEtag: `"${object.etag}"`,
        httpMetadata: { contentType: "image/jpeg" },
        customMetadata: { source: object.source, fetchedAt: object.fetchedAt },
      }),
      put: async (
        _key: string,
        value: ArrayBuffer,
        options: { customMetadata: Record<string, string>; onlyIf?: { etagMatches: string } },
      ) => {
        if (options.onlyIf && options.onlyIf.etagMatches !== object.etag) return null;
        const { source = "", fetchedAt = "" } = options.customMetadata;
        object = { bytes: new Uint8Array(value), etag: `etag-${++writes}`, source, fetchedAt };
        return {};
      },
    };
    const OTHER = new Uint8Array(25_000).fill(9);
    let cdnFailsA!: () => void;
    upstreams = [
      // Isolate A's CDN request hangs, then fails...
      () => new Promise<Response>((resolve) => (cdnFailsA = () => resolve(status(503)()))),
      // ...while isolate B's finds the jacket and stores it...
      image,
      // ...and A falls back to OpenLibrary's art.
      () => new Response(OTHER, { headers: { "Content-Type": "image/jpeg" } }),
    ];
    await get();
    // A second isolate: its own module state, and its own colo's edge cache.
    vi.resetModules();
    const isolateB = await import("./covers");
    edge.clear();
    await isolateB.coverResponse(new Request("https://mangadb.org/covers/9781974700523.jpg"));
    await vi.waitFor(() => expect(object.source).toBe(PRH));
    cdnFailsA();
    await settle();
    expect(fetches()).toEqual([PRH, PRH, OPEN_LIBRARY]);
    expect(object).toMatchObject({ bytes: JACKET, source: PRH, etag: "etag-2" });
  });

  test("an upstream that never answers frees its ISBN and its slot once it times out", async () => {
    const covers = stored({ source: PRH, fetchedAt: daysAgo(100) });
    // Every upstream request's timeout, run out by the test in its place.
    const expiry = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(expiry.signal);
    // A connection that is accepted and never answered: it settles only
    // when its signal aborts. One sent without a signal fails at once, so
    // this test fails rather than hangs.
    vi.mocked(fetch).mockImplementation(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) reject(new Error("sent without a timeout"));
          else if (signal.aborted) reject(signal.reason);
          else signal.addEventListener("abort", () => reject(signal.reason));
        }),
    );
    const cover = (n: number) =>
      coverResponse(new Request(`https://mangadb.org/covers/97819747005${40 + n}.jpg`));
    await Promise.all([0, 1, 2, 3, 4].map(cover));
    // Four checks hang; the fifth found every slot taken.
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(timeout).toHaveBeenCalledWith(10_000);
    expiry.abort(new DOMException("The operation timed out.", "TimeoutError"));
    await settle();
    timeout.mockRestore();
    expect(covers.put).not.toHaveBeenCalled();

    // A timed-out ISBN, and the one turned away, are both checked now.
    edge.clear();
    vi.mocked(fetch).mockImplementation(async () => image());
    await Promise.all([0, 4].map(cover));
    await settle();
    expect(covers.put).toHaveBeenCalledTimes(2);
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

describe("coverResponse refreshing stale jackets", () => {
  test("checks at most four stale jackets at once per isolate, serving each", async () => {
    const releases: Array<(response: Response) => void> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((resolve) => releases.push(resolve))),
    );
    worker.env.COVERS = {
      get: async () => ({
        arrayBuffer: async () => new Uint8Array(20_000).buffer,
        etag: "r2-tag",
        httpEtag: '"r2-tag"',
        customMetadata: { fetchedAt: new Date(0).toISOString() },
      }),
      put: async () => {},
    };
    const responses = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        coverResponse(new Request(`https://mangadb.org/covers/978197470052${i}.jpg`)),
      ),
    );
    const checks = releases.length;
    // Let every check end, a second upstream included, before afterEach waits on them.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 404 })),
    );
    for (const release of releases) release(new Response(null, { status: 404 }));
    expect(checks).toBe(4);
    expect(responses.every((res) => res?.status === 200)).toBe(true);
  });
});

describe("coverResponse validators", () => {
  const URL = "https://mangadb.org/covers/9781974700523.jpg";
  const KEY = URL;
  const STORED = new Uint8Array(30_000).fill(5);
  /** A request for the test cover revalidating with `ifNoneMatch`. */
  const revalidate = (ifNoneMatch: string) =>
    coverResponse(new Request(URL, { headers: { "If-None-Match": ifNoneMatch } }));
  /** An R2 bucket holding a fresh jacket tagged `"r2-tag"`. */
  const holding = () => {
    const covers = {
      get: vi.fn(async () => ({
        arrayBuffer: async () => STORED.slice().buffer,
        etag: "r2-tag",
        httpEtag: '"r2-tag"',
        httpMetadata: { contentType: "image/jpeg" },
        customMetadata: { fetchedAt: new Date().toISOString() },
      })),
      put: vi.fn(async () => {}),
    };
    worker.env.COVERS = covers;
    return covers;
  };

  test("a jacket from R2 carries R2's ETag", async () => {
    holding();
    const res = await get();
    expect(res?.status).toBe(200);
    expect(res?.headers.get("ETag")).toBe('"r2-tag"');
  });

  test("an R2 hit that matches If-None-Match is a 304 with the 200's caching headers", async () => {
    holding();
    const full = await get();
    edge.clear();
    const res = await revalidate('"r2-tag"');
    expect(res?.status).toBe(304);
    expect(res?.body).toBeNull();
    expect(res?.headers.get("ETag")).toBe('"r2-tag"');
    expect(res?.headers.get("Cache-Control")).toBe(full?.headers.get("Cache-Control"));
    expect(res?.headers.get("X-Cover-Origin")).toBe("r2");
    expect(res?.headers.get("Content-Type")).toBeNull();
  });

  test("an edge-cache hit that matches If-None-Match is a 304", async () => {
    const covers = holding();
    await get();
    await Promise.all(worker.background);
    expect(edge.has(KEY)).toBe(true);
    const res = await revalidate('"r2-tag"');
    expect(res?.status).toBe(304);
    expect(res?.headers.get("X-Cover-Cache")).toBe("hit");
    expect(res?.headers.get("ETag")).toBe('"r2-tag"');
    // Answered from the edge: R2 was read once, for the first request.
    expect(covers.get).toHaveBeenCalledTimes(1);
  });

  test("an edge-cache 304 keeps the cached copy's age and date", async () => {
    const date = new Date(Date.now() - 3_500_000).toUTCString();
    edge.set(
      KEY,
      new Response("jacket", {
        headers: {
          ETag: '"r2-tag"',
          "Cache-Control": "public, max-age=3600",
          Age: "3500",
          Date: date,
          Vary: "Accept",
          "X-Cover-Origin": "r2",
        },
      }),
    );
    const res = await revalidate('"r2-tag"');
    expect(res?.status).toBe(304);
    // A cache downstream would otherwise give the stale hour a fresh start.
    expect(res?.headers.get("Age")).toBe("3500");
    expect(res?.headers.get("Date")).toBe(date);
    expect(res?.headers.get("Vary")).toBe("Accept");
    expect(res?.headers.get("X-Cover-Origin")).toBe("r2");
    expect(res?.headers.get("X-Cover-Cache")).toBe("hit");
  });

  test.each([
    ["a weak form of the tag", 'W/"r2-tag"'],
    ["the tag among others", '"other", "r2-tag"'],
    ["any tag", "*"],
  ])("matches %s", async (_name, ifNoneMatch) => {
    holding();
    expect((await revalidate(ifNoneMatch))?.status).toBe(304);
  });

  test.each([
    ["from R2", false],
    ["from the edge", true],
  ])("a jacket %s whose tag the request doesn't name is the full 200", async (_name, fromEdge) => {
    holding();
    await get();
    await Promise.all(worker.background);
    if (!fromEdge) edge.clear();
    const res = await revalidate('"stale-tag"');
    expect(res?.status).toBe(200);
    expect(new Uint8Array(await res!.arrayBuffer())).toEqual(STORED);
    expect(res?.headers.get("ETag")).toBe('"r2-tag"');
  });

  test("a stale copy's 304 keeps its one-hour lifetime", async () => {
    worker.env.COVERS = {
      get: async () => ({
        arrayBuffer: async () => STORED.slice().buffer,
        etag: "r2-tag",
        httpEtag: '"r2-tag"',
        httpMetadata: { contentType: "image/jpeg" },
        customMetadata: { fetchedAt: new Date(0).toISOString() },
      }),
      put: async () => {},
    };
    upstreams = [status(404), status(404)];
    const res = await revalidate('"r2-tag"');
    expect(res?.status).toBe(304);
    expect(res?.headers.get("Cache-Control")).toBe("public, max-age=3600");
  });

  test("an upstream jacket is tagged as R2 will tag it, and revalidates from the edge", async () => {
    upstreams = [image];
    const res = await get();
    const md5 = createHash("md5").update(JACKET).digest("hex");
    expect(res?.headers.get("X-Cover-Origin")).toBe("upstream");
    expect(res?.headers.get("ETag")).toBe(`"${md5}"`);
    await Promise.all(worker.background);
    const again = await revalidate(`"${md5}"`);
    expect(again?.status).toBe(304);
    expect(again?.headers.get("X-Cover-Cache")).toBe("hit");
  });

  test("a miss is never a 304", async () => {
    upstreams = [status(404), status(404)];
    expect((await revalidate("*"))?.status).toBe(404);
  });

  test("a cached outage is never a 304", async () => {
    edge.set(
      KEY,
      new Response("Cover source unavailable", {
        status: 503,
        headers: { "Cache-Control": "public, max-age=300" },
      }),
    );
    expect((await revalidate("*"))?.status).toBe(503);
  });
});

describe("coverResponse waiting on upstreams", () => {
  const KEY = "https://mangadb.org/covers/9781974700523.jpg";
  /** An upstream answer the test releases, standing in for a slow CDN. */
  const held = () => {
    let release!: (response: Response) => void;
    const answer = new Promise<Response>((resolve) => (release = resolve));
    return { answer: () => answer, release };
  };
  const emptyBucket = () => {
    const covers = { get: vi.fn(async () => null), put: vi.fn(async () => ({})) };
    worker.env.COVERS = covers;
    return covers;
  };
  afterEach(() => {
    vi.useRealTimers();
  });

  test("an answer inside three seconds is served", async () => {
    vi.useFakeTimers();
    upstreams = [
      () => new Promise<Response>((resolve) => setTimeout(() => resolve(image()), 2_900)),
    ];
    const pending = get();
    await vi.advanceTimersByTimeAsync(2_900);
    const res = await pending;
    expect(res?.status).toBe(200);
    expect(res?.headers.get("X-Cover-Origin")).toBe("upstream");
  });

  test("past three seconds the visitor gets an uncached error at once, and the jacket is stored for the next", async () => {
    const covers = emptyBucket();
    const slow = held();
    upstreams = [slow.answer];
    vi.useFakeTimers();
    const pending = get();
    let settled = false;
    void pending.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(2_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const res = await pending;
    vi.useRealTimers();
    expect(res?.status).toBe(503);
    expect(res?.headers.get("Cache-Control")).toBe("no-store");
    expect(res?.headers.get("X-Cover-Origin")).toBe("pending");
    // Nothing remembered yet: the edge holds no answer, R2 no jacket.
    expect(edge.has(KEY)).toBe(false);
    expect(covers.put).not.toHaveBeenCalled();

    // The CDN answers after the visitor moved on; the lookup still runs to
    // its end, kept alive by waitUntil.
    slow.release(image());
    await Promise.all(worker.background);
    await Promise.all(worker.background);
    expect(covers.put).toHaveBeenCalledWith(
      "9781974700523.jpg",
      expect.anything(),
      expect.anything(),
    );
    expect(edge.get(KEY)?.status).toBe(200);
    const next = await get();
    expect(next?.status).toBe(200);
    expect(next?.headers.get("X-Cover-Cache")).toBe("hit");
    expect(new Uint8Array(await next!.arrayBuffer())).toEqual(JACKET);
  });

  test.each([
    ["a miss everywhere, remembered for a day", [status(404), status(404)], 404, 60 * 60 * 24],
    ["an outage, remembered for five minutes", [status(503), status(404)], 503, 300],
  ])("a late %s", async (_name, answers, code, maxAge) => {
    const slow = held();
    upstreams = [slow.answer, ...answers.slice(1)];
    vi.useFakeTimers();
    const pending = get();
    await vi.advanceTimersByTimeAsync(3_000);
    expect((await pending)?.status).toBe(503);
    vi.useRealTimers();
    slow.release(answers[0]!());
    await Promise.all(worker.background);
    await Promise.all(worker.background);
    const remembered = edge.get(KEY);
    expect(remembered?.status).toBe(code);
    expect(remembered?.headers.get("Cache-Control")).toBe(`public, max-age=${maxAge}`);
  });

  test("a stored jacket is never held up by the budget", async () => {
    const OLD = new Uint8Array(30_000).fill(3);
    worker.env.COVERS = {
      get: async () => ({
        arrayBuffer: async () => OLD.slice().buffer,
        etag: "e",
        httpEtag: '"e"',
        httpMetadata: { contentType: "image/jpeg" },
        customMetadata: { fetchedAt: new Date(0).toISOString() },
      }),
      put: async () => {},
    };
    // Its check hangs in the background; the copy is served regardless.
    const slow = held();
    upstreams = [slow.answer];
    const res = await get();
    expect(res?.status).toBe(200);
    expect(res?.headers.get("X-Cover-Origin")).toBe("r2");
    slow.release(status(404)());
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
  const key = (n: number) => `${isbn(n)}.jpg`;
  /** An R2 bucket holding jackets for `held`, counting its head reads. */
  const bucket = (held: Array<string>) => {
    const keys = new Set(held.map((value) => `${value}.jpg`));
    const head = vi.fn(async (key: string) => (keys.has(key) ? {} : null));
    return { head, get: vi.fn(async () => null), put: vi.fn(async () => {}) };
  };
  /** Heads not answered yet; afterEach answers each, so no test leaves work hanging. */
  const unanswered: Array<() => void> = [];
  /** An R2 head the test answers when it chooses. */
  const later = () => {
    let answer!: (value: object | null) => void;
    let fail!: (error: Error) => void;
    const head = new Promise<object | null>((resolve, reject) => {
      answer = resolve;
      fail = reject;
    });
    // A head never sent may still be failed by a test: that is not an unhandled rejection.
    head.catch(() => {});
    unanswered.push(() => answer(null));
    return {
      head,
      onFile: () => answer({}),
      absent: () => answer(null),
      fail: () => fail(new Error("r2 down")),
    };
  };
  type Step = "on" | "off" | "fail" | ReturnType<typeof later>;
  /** A bound bucket answering each ISBN per `plan` (unlisted: absent), counting its head reads. */
  const scripted = (plan: Record<string, Step>) => {
    const head = vi.fn(async (key: string): Promise<object | null> => {
      const step = plan[key.replace(/\.jpg$/, "")] ?? "off";
      if (step === "on") return {};
      if (step === "off") return null;
      if (step === "fail") throw new Error("r2 down");
      return step.head;
    });
    const covers = {
      head,
      get: vi.fn(async (_key: string): Promise<null> => null),
      put: vi.fn(async () => {}),
    };
    worker.env.COVERS = covers;
    return covers;
  };
  const keysRead = (covers: { head: { mock: { calls: Array<Array<unknown>> } } }) =>
    covers.head.mock.calls.map(([key]) => key);
  /**
   * Under fake timers, run time to the budget: `pending` must still wait at
   * 299 ms and have settled at 300 ms (each fired timer is followed by a real
   * turn, so its callbacks have run). An unbounded check fails here, not by
   * hanging.
   */
  const atBudget = async <T>(pending: Promise<T>): Promise<T> => {
    let settled = false;
    void pending.then(
      () => (settled = true),
      () => (settled = true),
    );
    await vi.advanceTimersByTimeAsync(299);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    return pending;
  };
  /** A call's answer once its budget has run out, under fake timers. */
  const pastBudget = async (shelves: Parameters<typeof coversOnFile>[0], origin = ORIGIN) => {
    vi.useFakeTimers();
    const answer = await atBudget(coversOnFile(shelves, origin));
    vi.useRealTimers();
    return answer;
  };
  /** Let every callback that is ready run (real timers). */
  const drain = () => new Promise((resolve) => setTimeout(resolve, 0));
  /** Wait for owned work, including work it registers as it goes. */
  const settleBackground = async () => {
    let seen: number;
    do {
      seen = worker.background.length;
      await Promise.all(worker.background);
    } while (worker.background.length !== seen);
  };
  /** Whether each piece of owned work has settled, once ready callbacks have run. */
  const ownersSettled = async () => {
    const states = worker.background.map((owner) => {
      const state = { settled: false };
      void owner.then(
        () => (state.settled = true),
        () => (state.settled = true),
      );
      return state;
    });
    await drain();
    return states.map((state) => state.settled);
  };
  /** The ISBNs a call made from `origin` warmed: each warm-up leaves its answer at the edge. */
  const warmedFrom = (origin: string) =>
    [...edge.keys()]
      .filter((url) => url.startsWith(`${origin}/covers/`))
      .map((url) => url.slice(`${origin}/covers/`.length, -".jpg".length));
  let errors: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    upstreams = [];
    errors = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  // Runs before the file's afterEach waits on the background, even when a
  // test failed midway: real timers back, then every held head answered.
  afterEach(() => {
    vi.useRealTimers();
    worker.refuse = false;
    for (const answer of unanswered.splice(0)) answer();
    errors.mockRestore();
  });

  test("says nothing when no bucket is bound, and starts no timer", async () => {
    vi.useFakeTimers();
    expect(await coversOnFile([{ need: 2, candidates: [isbn(1)] }], ORIGIN)).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    expect(worker.background).toEqual([]);
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
    const candidates = ["../secrets", "9781974", 9781974000061, isbn(60)] as Array<string>;
    expect(await coversOnFile([{ need: 3, candidates }], ORIGIN)).toEqual([]);
    expect(keysRead(covers)).toEqual([key(60)]);
  });

  test("fetches an absent jacket in the background for the next visitor", async () => {
    const covers = bucket([]);
    worker.env.COVERS = covers;
    upstreams = [image];
    expect(await coversOnFile([{ need: 1, candidates: [isbn(70)] }], ORIGIN)).toEqual([]);
    await settleBackground();
    expect(covers.put).toHaveBeenCalledWith(key(70), expect.anything(), expect.anything());
  });

  test("a failed R2 read is unknown: the book keeps its seat, is never warmed, and is asked again", async () => {
    const covers = scripted({ [isbn(80)]: "fail" });
    const shelf = { need: 1, candidates: [isbn(80)] };
    expect(await coversOnFile([shelf], ORIGIN)).toEqual([isbn(80)]);
    await settleBackground();
    expect(covers.get).not.toHaveBeenCalled();
    const next = scripted({ [isbn(80)]: "on" });
    expect(await coversOnFile([shelf], ORIGIN)).toEqual([isbn(80)]);
    expect(next.head).toHaveBeenCalledTimes(1);
  });

  test("a head that throws before it returns is a failed read too", async () => {
    const covers = scripted({});
    covers.head.mockImplementation(() => {
      throw new Error("binding broken");
    });
    expect(await coversOnFile([{ need: 2, candidates: [isbn(75), isbn(76)] }], ORIGIN)).toEqual([
      isbn(75),
      isbn(76),
    ]);
    expect(covers.head).toHaveBeenCalledTimes(2);
  });

  test("an R2 outage costs one read per seat", async () => {
    const plan = Object.fromEntries(
      [81, 82, 83, 84, 85, 86, 87, 88].map((n) => [isbn(n), "fail" as const]),
    );
    const covers = scripted(plan);
    const shelf = { need: 2, candidates: Object.keys(plan) };
    expect(await coversOnFile([shelf], ORIGIN)).toEqual([isbn(81), isbn(82)]);
    expect(covers.head).toHaveBeenCalledTimes(2);
    await settleBackground();
    expect(covers.get).not.toHaveBeenCalled();
  });

  describe("when the budget runs out", () => {
    test("an answer that landed is kept although a neighbour stalls", async () => {
      // need 3: A on file, B absent, C stalled.
      scripted({ [isbn(500)]: "on", [isbn(501)]: "off", [isbn(502)]: later() });
      const shelf = { need: 3, candidates: [isbn(500), isbn(501), isbn(502)] };
      expect(await pastBudget([shelf])).toEqual([isbn(500), isbn(502)]);
    });

    test("a stalled read keeps its seat and the next candidate fills the one an absence freed", async () => {
      // need 2: A absent, B stalled, C on file.
      const covers = scripted({ [isbn(100)]: "off", [isbn(101)]: later(), [isbn(102)]: "on" });
      const shelf = { need: 2, candidates: [isbn(100), isbn(101), isbn(102), isbn(103)] };
      expect(await pastBudget([shelf])).toEqual([isbn(101), isbn(102)]);
      expect(keysRead(covers)).toEqual([key(100), key(101), key(102)]);
    });

    test("candidates not answered yet keep their seats, in shelf order", async () => {
      scripted({ [isbn(110)]: later(), [isbn(111)]: later(), [isbn(112)]: "on" });
      const shelf = { need: 2, candidates: [isbn(110), isbn(111), isbn(112)] };
      expect(await pastBudget([shelf])).toEqual([isbn(110), isbn(111)]);
    });

    test("an earlier unknown outranks a later jacket on file", async () => {
      scripted({ [isbn(171)]: "on" });
      await coversOnFile([{ need: 1, candidates: [isbn(171)] }], ORIGIN);
      const covers = scripted({ [isbn(170)]: later() });
      expect(await pastBudget([{ need: 1, candidates: [isbn(170), isbn(171)] }])).toEqual([
        isbn(170),
      ]);
      expect(keysRead(covers)).toEqual([key(170)]);
    });

    test("publisher art and an unknown share a shelf without a read for the art", async () => {
      const covers = scripted({ [isbn(180)]: later(), [isbn(181)]: "on" });
      expect(await pastBudget([{ need: 2, candidates: [null, isbn(180), isbn(181)] }])).toEqual([
        isbn(180),
      ]);
      expect(keysRead(covers)).toEqual([key(180)]);
    });

    test("an ISBN on two shelves is read once and answers the same on both", async () => {
      const covers = scripted({ [isbn(150)]: "on", [isbn(151)]: later(), [isbn(152)]: "on" });
      const answer = await pastBudget([
        { need: 2, candidates: [isbn(150), isbn(151)] },
        { need: 2, candidates: [isbn(151), isbn(152)] },
      ]);
      expect(answer).toEqual([isbn(150), isbn(151), isbn(152)]);
      expect(keysRead(covers).filter((read) => read === key(151))).toHaveLength(1);
    });

    test("every read still out stays owned until it lands, and none starts after the budget", async () => {
      // need 3 over four: three reads are out at the budget.
      const a = later();
      const b = later();
      const c = later();
      const covers = scripted({
        [isbn(600)]: a,
        [isbn(601)]: b,
        [isbn(602)]: c,
        [isbn(603)]: "on",
      });
      const shelf = { need: 3, candidates: [isbn(600), isbn(601), isbn(602), isbn(603)] };
      const answer = await pastBudget([shelf]);
      const copy = [...(answer ?? [])];
      expect(answer).toEqual([isbn(600), isbn(601), isbn(602)]);
      // A late absence frees a seat, but no read starts; B and C are still owned.
      a.absent();
      expect(await ownersSettled()).toContain(false);
      b.onFile();
      expect(await ownersSettled()).toContain(false);
      c.fail();
      expect(await ownersSettled()).not.toContain(false);
      expect(keysRead(covers)).toEqual([key(600), key(601), key(602)]);
      expect(answer).toEqual(copy);
      // The next request remembers A absent and B on file, and asks again about C.
      const next = scripted({ [isbn(602)]: "on", [isbn(603)]: "on" });
      expect(await coversOnFile([shelf], ORIGIN)).toEqual([isbn(601), isbn(602), isbn(603)]);
      expect(keysRead(next)).toEqual([key(602), key(603)]);
    });

    test("a late failure is logged and not remembered", async () => {
      const stalled = later();
      scripted({ [isbn(140)]: stalled });
      const shelf = { need: 1, candidates: [isbn(140)] };
      expect(await pastBudget([shelf])).toEqual([isbn(140)]);
      stalled.fail();
      await settleBackground();
      expect(errors).toHaveBeenCalledWith("covers: R2 head failed", expect.any(Error));
      const next = scripted({ [isbn(140)]: "off" });
      expect(await coversOnFile([shelf], ORIGIN)).toEqual([]);
      expect(next.head).toHaveBeenCalledTimes(1);
    });

    test("an absence another request learned meanwhile keeps an unread candidate off", async () => {
      // A, B, C, D; C remembered absent; this request's reads of A and B are out.
      const a = isbn(800);
      const b = isbn(801);
      const c = isbn(802);
      const d = isbn(803);
      scripted({});
      await coversOnFile([{ need: 1, candidates: [c] }], ORIGIN);
      const own: Record<string, ReturnType<typeof later>> = { [a]: later(), [b]: later() };
      const covers = scripted({});
      let readsOfA = 0;
      covers.head.mockImplementation(async (asked: string) => {
        const isbn13 = asked.replace(/\.jpg$/, "");
        if (isbn13 === a && readsOfA++ > 0) return null; // the other request's read
        return own[isbn13]?.head ?? null;
      });
      edge.clear();
      vi.useFakeTimers();
      const pending = coversOnFile([{ need: 2, candidates: [a, b, c, d] }], "https://one.test");
      // Another request in the isolate reads A as absent while ours waits.
      expect(await coversOnFile([{ need: 1, candidates: [a] }], "https://two.test")).toEqual([]);
      const answer = await atBudget(pending);
      vi.useRealTimers();
      // A and C are known absent; B is still out and D was never read.
      expect(answer).toEqual([b, d]);
      expect(keysRead(covers)).toEqual([`${a}.jpg`, `${b}.jpg`, `${a}.jpg`]);
      for (const head of Object.values(own)) head.absent();
      await settleBackground();
      expect(warmedFrom("https://one.test").sort()).toEqual([a, c]);
    });

    test("an absence remembered past its five minutes is unknown again", async () => {
      const a = isbn(810);
      const b = isbn(811);
      const c = isbn(812);
      const d = isbn(813);
      vi.useFakeTimers();
      scripted({});
      await coversOnFile([{ need: 1, candidates: [c] }], ORIGIN);
      vi.setSystemTime(Date.now() + 5 * 60_000 + 1);
      const own: Record<string, ReturnType<typeof later>> = { [a]: later(), [b]: later() };
      const covers = scripted({});
      let readsOfA = 0;
      covers.head.mockImplementation(async (asked: string) => {
        const isbn13 = asked.replace(/\.jpg$/, "");
        if (isbn13 === a && readsOfA++ > 0) return null;
        return own[isbn13]?.head ?? null;
      });
      const pending = coversOnFile([{ need: 2, candidates: [a, b, c, d] }], ORIGIN);
      await coversOnFile([{ need: 1, candidates: [a] }], ORIGIN);
      expect(await atBudget(pending)).toEqual([b, c]);
    });

    test("a remembered answer past the seats is neither looked up nor warmed", async () => {
      scripted({});
      await coversOnFile([{ need: 1, candidates: [isbn(821)] }], ORIGIN);
      edge.clear();
      scripted({ [isbn(820)]: "on" });
      expect(
        await coversOnFile([{ need: 1, candidates: [isbn(820), isbn(821)] }], "https://three.test"),
      ).toEqual([isbn(820)]);
      await settleBackground();
      expect(warmedFrom("https://three.test")).toEqual([]);
    });
  });

  describe("bounds", () => {
    test.each([
      ["missing", undefined, 0, 1000],
      ["not a number", Number.NaN, 0, 1120],
      ["a string", "4", 0, 1240],
      ["infinite", Number.POSITIVE_INFINITY, 0, 1360],
      ["negative", -3, 0, 1480],
      ["zero", 0, 0, 1600],
      ["fractional", 2.7, 2, 1720],
      ["too large", 1_000_000, 30, 1840],
    ])("a need that is %s sends at most its seats' reads", async (_name, need, seats, first) => {
      // 120 candidates of its own, every read held until counted, then failed.
      const held = Array.from({ length: 120 }, () => later());
      const covers = scripted(Object.fromEntries(held.map((head, n) => [isbn(first + n), head])));
      const shelf = { need, candidates: held.map((_, n) => isbn(first + n)) } as CoverShelf;
      const pending = coversOnFile([shelf], ORIGIN);
      expect(covers.head).toHaveBeenCalledTimes(seats);
      for (const head of held) head.fail();
      expect(await pending).toHaveLength(seats);
      expect(covers.head).toHaveBeenCalledTimes(seats);
    });

    test("eight shelves of thirty send at most 240 reads at once", async () => {
      const held = Array.from({ length: 9 * 120 }, () => later());
      const covers = scripted(Object.fromEntries(held.map((head, n) => [isbn(3000 + n), head])));
      const shelves = Array.from({ length: 9 }, (_, s) => ({
        need: 30,
        candidates: Array.from({ length: 120 }, (_, n) => isbn(3000 + s * 120 + n)),
      }));
      const pending = coversOnFile(shelves, ORIGIN);
      expect(covers.head).toHaveBeenCalledTimes(240);
      expect(keysRead(covers)).not.toContain(key(3000 + 8 * 120));
      for (const head of held) head.fail();
      expect(await pending).toHaveLength(240);
    });

    test("asks about the first 120 candidates only, counted before non-ISBNs are dropped", async () => {
      const covers = scripted({});
      const junk = Array.from({ length: 120 }, () => "not-an-isbn");
      const shelves = [
        { need: 5, candidates: [...junk, isbn(700)] },
        ...Array.from({ length: 7 }, (_, s) => ({ need: 1, candidates: [isbn(701 + s)] })),
        { need: 1, candidates: [isbn(708)] },
      ];
      expect(await coversOnFile(shelves, ORIGIN)).toEqual([]);
      expect(keysRead(covers)).toEqual([701, 702, 703, 704, 705, 706, 707].map(key));
    });

    test("an absent shelf reads its first 120 candidates, no more", async () => {
      const covers = scripted({});
      const many = Array.from({ length: 200 }, (_, n) => isbn(200 + n));
      expect(await coversOnFile([{ need: 100, candidates: many }], ORIGIN)).toEqual([]);
      expect(keysRead(covers)).toEqual(many.slice(0, 120).map((value) => `${value}.jpg`));
    });

    test("the caller's arrays can change afterwards without changing the question", async () => {
      const stalled = later();
      const covers = scripted({ [isbn(720)]: stalled, [isbn(721)]: "on" });
      const shelf = { need: 1, candidates: [isbn(720), isbn(721)] };
      const shelves = [shelf];
      const pending = coversOnFile(shelves, ORIGIN);
      shelf.need = 2;
      shelf.candidates.push(isbn(722));
      shelves.push({ need: 1, candidates: [isbn(723)] });
      stalled.absent();
      expect(await pending).toEqual([isbn(721)]);
      expect(keysRead(covers)).toEqual([key(720), key(721)]);
    });

    test("an ISBN listed twice on a shelf takes both seats with one read", async () => {
      const covers = scripted({ [isbn(160)]: "on", [isbn(161)]: "on" });
      const shelf = { need: 2, candidates: [isbn(160), isbn(160), isbn(161)] };
      expect(await coversOnFile([shelf], ORIGIN)).toEqual([isbn(160)]);
      expect(keysRead(covers)).toEqual([key(160)]);
    });
  });

  describe("its budget", () => {
    test("is armed before the first read", async () => {
      vi.useFakeTimers();
      const timersAtRead: Array<number> = [];
      const covers = scripted({});
      covers.head.mockImplementation(async () => {
        timersAtRead.push(vi.getTimerCount());
        return {};
      });
      expect(await coversOnFile([{ need: 1, candidates: [isbn(900)] }], ORIGIN)).toEqual([
        isbn(900),
      ]);
      expect(timersAtRead).toEqual([1]);
    });

    test("a call answered in full leaves no timer and warms nothing", async () => {
      vi.useFakeTimers();
      const covers = scripted({ [isbn(400)]: "on", [isbn(401)]: "on" });
      const answer = await coversOnFile([{ need: 2, candidates: [isbn(400), isbn(401)] }], ORIGIN);
      expect(answer).toEqual([isbn(400), isbn(401)]);
      expect(vi.getTimerCount()).toBe(0);
      vi.useRealTimers();
      await settleBackground();
      expect(covers.get).not.toHaveBeenCalled();
    });

    test("a call that read nothing owns nothing", async () => {
      scripted({ [isbn(402)]: "on" });
      await coversOnFile([{ need: 1, candidates: [isbn(402)] }], ORIGIN);
      await settleBackground();
      worker.background.length = 0;
      expect(await coversOnFile([{ need: 1, candidates: [isbn(402)] }], ORIGIN)).toEqual([
        isbn(402),
      ]);
      expect(worker.background).toEqual([]);
    });

    test("when the runtime will not own the reads still out, the call fails and no read follows", async () => {
      const stalled = later();
      const covers = scripted({ [isbn(910)]: stalled, [isbn(911)]: "on" });
      worker.refuse = true;
      vi.useFakeTimers();
      const outcome = coversOnFile([{ need: 1, candidates: [isbn(910), isbn(911)] }], ORIGIN).then(
        () => "answered",
        (error: Error) => error.message,
      );
      expect(await atBudget(outcome)).toBe("waitUntil refused");
      expect(vi.getTimerCount()).toBe(0);
      vi.useRealTimers();
      worker.refuse = false;
      // An absence frees the seat, but the check is over.
      stalled.absent();
      await drain();
      expect(keysRead(covers)).toEqual([key(910)]);
    });
  });

  describe("warm-ups", () => {
    test("at most 8 absent jackets, once each, without waiting for them", async () => {
      const covers = scripted({});
      const absent = Array.from({ length: 12 }, (_, n) => isbn(410 + n));
      let release!: () => void;
      const slow = new Promise<null>((resolve) => (release = () => resolve(null)));
      covers.get.mockImplementation(() => slow);
      try {
        const answer = await coversOnFile(
          [
            { need: 12, candidates: absent },
            { need: 12, candidates: absent },
          ],
          ORIGIN,
        );
        expect(answer).toEqual([]);
        // Warm-ups have started but none has finished: R2 get has not answered.
        await drain();
        expect(covers.get.mock.calls.map(([key]) => key)).toEqual(
          absent.slice(0, 8).map((value) => `${value}.jpg`),
        );
      } finally {
        release();
      }
    });

    test("a remembered absence is warmed again without a read", async () => {
      const covers = scripted({});
      const shelf = { need: 1, candidates: [isbn(430)] };
      await coversOnFile([shelf], "https://first.test");
      await settleBackground();
      expect(warmedFrom("https://first.test")).toEqual([isbn(430)]);
      await coversOnFile([shelf], "https://second.test");
      await settleBackground();
      expect(warmedFrom("https://second.test")).toEqual([isbn(430)]);
      expect(covers.head).toHaveBeenCalledTimes(1);
    });

    test("an absence that lands after the budget is not warmed by that call", async () => {
      const stalled = later();
      scripted({ [isbn(440)]: stalled });
      edge.clear();
      await pastBudget([{ need: 1, candidates: [isbn(440)] }], "https://late.test");
      stalled.absent();
      await settleBackground();
      expect(warmedFrom("https://late.test")).toEqual([]);
    });
  });

  describe("Server-Timing", () => {
    /** The cov and covr2 metrics a request running `ask` reports. */
    const spans = async (ask: () => Promise<unknown>) => {
      const response = await timeRequest(async () => {
        await ask();
        return new Response("ok");
      });
      return (response.headers.get("Server-Timing") ?? "")
        .split(", ")
        .filter((metric) => metric.startsWith("cov"))
        .map((metric) => metric.replace(/;dur=[\d.]+/, ""));
    };

    test("counts the R2 heads actually sent, and none for what it remembers", async () => {
      const covers = bucket([isbn(90), isbn(92)]);
      worker.env.COVERS = covers;
      // A shelf of 2 over 4 candidates reads 90, 91, then 92; the second
      // shelf repeats 90, which the memo now answers.
      const shelves = [
        { need: 2, candidates: [isbn(90), isbn(91), isbn(92), isbn(93)] },
        { need: 1, candidates: [null] },
      ];
      expect(await spans(() => coversOnFile(shelves, ORIGIN))).toEqual([
        'cov;desc="complete"',
        'covr2;desc="3"',
      ]);
      expect(covers.head).toHaveBeenCalledTimes(3);
      expect(await spans(() => coversOnFile(shelves, ORIGIN))).toEqual([
        'cov;desc="complete"',
        'covr2;desc="0"',
      ]);
      expect(covers.head).toHaveBeenCalledTimes(3);
    });

    test("a read that threw makes the check failed", async () => {
      const covers = bucket([]);
      covers.head.mockRejectedValueOnce(new Error("r2 down"));
      worker.env.COVERS = covers;
      expect(
        await spans(() => coversOnFile([{ need: 1, candidates: [isbn(95)] }], ORIGIN)),
      ).toEqual(['cov;desc="failed"', 'covr2;desc="1"']);
    });

    test("a budget that runs out first makes the check partial, counting only the heads sent", async () => {
      scripted({ [isbn(99)]: later() });
      vi.useFakeTimers();
      const metrics = spans(() =>
        coversOnFile([{ need: 2, candidates: [isbn(98), isbn(99)] }], ORIGIN),
      );
      expect(await atBudget(metrics)).toEqual(['cov;desc="partial"', 'covr2;desc="2"']);
    });

    test("an ISBN on two shelves is one head", async () => {
      scripted({ [isbn(96)]: "on" });
      expect(
        await spans(() =>
          coversOnFile(
            [
              { need: 1, candidates: [isbn(96)] },
              { need: 1, candidates: [isbn(96)] },
            ],
            ORIGIN,
          ),
        ),
      ).toEqual(['cov;desc="complete"', 'covr2;desc="1"']);
    });

    test("no bucket is unbound, with no head count", async () => {
      expect(
        await spans(() => coversOnFile([{ need: 1, candidates: [isbn(97)] }], ORIGIN)),
      ).toEqual(['cov;desc="unbound"']);
    });
  });
});
