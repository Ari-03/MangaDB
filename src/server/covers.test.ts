import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ env: {} }));
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
afterEach(() => vi.unstubAllGlobals());

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
});
