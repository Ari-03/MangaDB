import { afterEach, describe, expect, it, vi } from "vitest";

import { politeFetch } from "./http";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Run politeFetch with every backoff sleep fast-forwarded. */
async function fetchWithClock(url: string) {
  vi.useFakeTimers();
  const pending = politeFetch(url, 0);
  // Surface the result either way, then let the timers run out the backoff.
  const settled = pending.then(
    (res) => ({ res, error: null }),
    (error: unknown) => ({ res: null, error }),
  );
  await vi.runAllTimersAsync();
  return await settled;
}

describe("politeFetch", () => {
  it("waits out a rate limit and then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("slow down", { status: 429, headers: { "Retry-After": "5" } }))
      .mockResolvedValueOnce(new Response("<ann/>", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { res } = await fetchWithClock("https://example.test/api");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await res?.text()).toBe("<ann/>");
  });

  it("retries a body that fails to read", async () => {
    const broken = new Response("x", { status: 200 });
    vi.spyOn(broken, "arrayBuffer").mockRejectedValueOnce(new Error("error decoding response body"));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(broken)
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { res } = await fetchWithClock("https://example.test/page");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await res?.text()).toBe("ok");
  });

  it("fails at once on a client error that won't heal", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("gone", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    const { error } = await fetchWithClock("https://example.test/missing");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(error)).toMatch(/HTTP 404/);
  });

  it("gives up after five rate-limited attempts", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response("no", { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);
    const { error } = await fetchWithClock("https://example.test/busy");
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(String(error)).toMatch(/HTTP 429/);
  });
});
