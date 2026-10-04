// @vitest-environment happy-dom
// @vitest-environment-options {"url": "https://mangadb.test/"}

// The PostHog client (lib/analyticsClient.tsx) against the real posthog-js
// in a happy-dom page: its options and applyConsent drive posthog.init and
// every consent change, as the provider and ConsentSync do. fetch, XHR and
// sendBeacon are stubbed, so nothing leaves the process, and every request
// body is decoded into the events it carries. A page load is a fresh
// posthog-js module over the same localStorage and cookies. Assertions are
// on the payloads: which ids and URLs actually went out.

import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AnalyticsConsent } from "./analytics";

vi.mock("@clerk/tanstack-react-start", () => ({ useAuth: () => ({ isLoaded: false }) }));

type Sent = { event: string; properties: Record<string, unknown>; raw: string };

// Every request's URL, and the events the request bodies carried.
const requests: string[] = [];
const events: Sent[] = [];
const decoding: Array<Promise<void>> = [];

// posthog-js patches history once per window; each page load starts from
// the browser's own methods, as a real reload does.
const pristineHistory = { pushState: history.pushState, replaceState: history.replaceState };

/** A request body as text, gunzipped when posthog-js compressed it. */
async function bodyText(body: unknown): Promise<string> {
  if (body === undefined || body === null) return "";
  if (typeof body === "string") return body;
  const bytes = new Uint8Array(
    body instanceof Blob
      ? await body.arrayBuffer()
      : body instanceof ArrayBuffer
        ? body
        : ArrayBuffer.isView(body)
          ? body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
          : new ArrayBuffer(0),
  );
  const gzipped = bytes[0] === 0x1f && bytes[1] === 0x8b;
  return new TextDecoder().decode(gzipped ? gunzipSync(bytes) : bytes);
}

/** The events a request body carries: JSON, or base64 form data. */
function eventsIn(text: string): Array<{ event: string; properties: Record<string, unknown> }> {
  if (text === "") return [];
  const json = text.startsWith("data=") ? atob(decodeURIComponent(text.slice(5))) : text;
  const parsed: unknown = JSON.parse(json);
  const list = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "object" && parsed !== null && "batch" in parsed && Array.isArray(parsed.batch)
      ? parsed.batch
      : [parsed];
  return list;
}

/**
 * Route this page load's fetch, XHR and beacons into `requests` and
 * `events`. posthog-js reads these once, when its module loads. Without
 * CompressionStream it gzips synchronously, so a flush sends at once.
 */
function stubNetwork() {
  vi.stubGlobal("CompressionStream", undefined);
  const record = (url: string, body: unknown) => {
    requests.push(url);
    decoding.push(
      bodyText(body).then((text) => {
        for (const { event, properties } of eventsIn(text)) {
          events.push({ event, properties, raw: JSON.stringify({ event, properties }) });
        }
      }),
    );
  };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    record(String(input), init?.body);
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal(
    "XMLHttpRequest",
    class {
      withCredentials = false;
      readyState = 0;
      status = 0;
      responseText = "{}";
      onreadystatechange: (() => void) | null = null;
      private url = "";
      open(_method: string, url: string) {
        this.url = url;
      }
      setRequestHeader() {}
      send(body?: unknown) {
        record(this.url, body);
        Object.assign(this, { readyState: 4, status: 200 });
        this.onreadystatechange?.();
      }
    },
  );
  Object.defineProperty(navigator, "sendBeacon", {
    configurable: true,
    value: (url: string, body?: unknown) => {
      record(url, body);
      return true;
    },
  });
}

/** Let timers run (the initial pageview, batch flushes) and decode what was sent. */
async function settle() {
  await vi.advanceTimersByTimeAsync(5_000);
  await Promise.all(decoding.splice(0));
}

/**
 * Load a page at `path` with the client on it, applying `consent` at load
 * as the provider's `loaded` does. Navigation inside the page goes through
 * history.pushState, as the router's does.
 */
async function openPage(path: string, consent: AnalyticsConsent) {
  Object.assign(history, pristineHistory);
  history.replaceState(null, "", path);
  stubNetwork();
  vi.resetModules();
  const { default: posthog } = await import("posthog-js");
  const client = await import("./analyticsClient");
  posthog.init("phc_test", {
    ...client.clientOptions(() => consent, () => {}),
    // happy-dom's user agent reads as a bot, which posthog-js drops.
    opt_out_useragent_filter: true,
  });
  await settle();
  return {
    posthog,
    /** What ConsentSync does when the session's consent changes. */
    apply: async (next: AnalyticsConsent) => {
      client.applyConsent(next);
      await settle();
    },
    go: async (to: string) => {
      history.pushState(null, "", to);
      await settle();
    },
  };
}

/** A page visited with no client loaded (an opted-out viewer's page loads). */
function visitWithoutClient(path: string) {
  Object.assign(history, pristineHistory);
  history.replaceState(null, "", path);
}

/** Every event sent from index `from` of `events` on. */
const since = (from: number) => events.slice(from);

/** Each event's name and distinct id, sorted: batched and instant sends can arrive either way round. */
const named = (sent: Sent[]) =>
  sent.map((e) => [e.event, e.properties.distinct_id]).sort((a, b) => String(a).localeCompare(String(b)));

const identified = (userId: string): AnalyticsConsent => ({
  status: "identified",
  userId,
  username: userId,
  role: null,
});
const ANONYMOUS: AnalyticsConsent = { status: "anonymous" };
const PENDING: AnalyticsConsent = { status: "pending" };
const OFF: AnalyticsConsent = { status: "off" };

// The pages browsed while analytics is off carry this in their address,
// and only they are at /search, so a leaked pathname shows too.
const OFF_TIME = "offtime";

function expectNothingFromOffTime(sent: Sent[]) {
  for (const event of sent) {
    expect(event.raw).not.toContain(OFF_TIME);
    expect(event.raw).not.toContain('"/search"');
  }
  expect(sent.map((event) => event.event)).not.toContain("$opt_in");
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  sessionStorage.clear();
  for (const cookie of document.cookie.split(";")) {
    const name = cookie.split("=")[0]!.trim();
    if (name !== "") document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
  }
  Object.defineProperty(navigator, "doNotTrack", { configurable: true, value: null });
  requests.length = 0;
  events.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("analyticsClient against posthog-js", () => {
  it("sends nothing, not even the initial pageview, while pending and then off", async () => {
    const page = await openPage("/", PENDING);
    await page.go("/series/1");
    await page.apply(OFF);
    await page.go(`/search?q=${OFF_TIME}`);
    expect(requests).toEqual([]);
  });

  it("carries nothing from the pages browsed while off when the account turns analytics back on", async () => {
    const page = await openPage("/", identified("user_a"));
    await page.go("/series/1");
    await page.apply(OFF);
    await page.go(`/series/${OFF_TIME}`);
    await page.go(`/search?q=${OFF_TIME}-query`);
    await page.go("/me");
    const resumed = events.length;
    await page.apply(identified("user_a"));
    await page.go("/series/2");

    const sent = since(resumed);
    expectNothingFromOffTime(sent);
    expect(sent.map((e) => [e.event, e.properties.distinct_id, e.properties.$pathname])).toEqual([
      ["$pageview", "user_a", "/series/2"],
    ]);
    expect(sent[0]!.properties.$prev_pageview_pathname).toBe("/series/1");
  });

  it("carries nothing from the pages browsed while off across a session timeout and a reload", async () => {
    const first = await openPage("/", identified("user_a"));
    await first.go("/series/1");
    await first.apply(OFF);
    vi.setSystemTime(Date.now() + 31 * 60 * 1000);
    await first.go(`/search?q=${OFF_TIME}-query`);
    // Reloaded while off: the gate loads no client. Turned on from /me.
    visitWithoutClient(`/search?q=${OFF_TIME}-query`);
    visitWithoutClient("/me");
    const resumed = events.length;
    await openPage("/me", identified("user_a"));

    const sent = since(resumed);
    expectNothingFromOffTime(sent);
    // identify() on a new page load sets the person's properties again.
    expect(named(sent)).toEqual([
      ["$pageview", "user_a"],
      ["$set", "user_a"],
    ]);
    for (const event of sent) expect(event.properties.$session_entry_url).toBe("https://mangadb.test/me");
  });

  it("carries nothing from an opted-out account's pages to the next anonymous pageview after sign-out", async () => {
    const page = await openPage("/", ANONYMOUS);
    await page.go("/series/1");
    const anonymousId = page.posthog.get_distinct_id();
    await page.apply(PENDING);
    await page.go(`/pending-${OFF_TIME}`);
    await page.apply(OFF);
    await page.go(`/series/${OFF_TIME}`);
    await page.go(`/search?q=${OFF_TIME}-query`);
    const signedOut = events.length;
    await page.apply(ANONYMOUS);
    await page.go("/series/2");

    const sent = since(signedOut);
    expectNothingFromOffTime(sent);
    expect(sent.map((e) => [e.event, e.properties.distinct_id, e.properties.$pathname])).toEqual([
      ["$pageview", anonymousId, "/series/2"],
    ]);
    expect(sent[0]!.properties.$prev_pageview_pathname).toBe("/series/1");
  });

  it("captures signed-out visits again after an opted-out account signs out, on the page and after a reload", async () => {
    const page = await openPage("/", identified("user_a"));
    await page.apply(OFF);
    const signedOut = events.length;
    await page.apply(ANONYMOUS);
    await page.go("/series/1");
    expect(since(signedOut).map((e) => [e.event, e.properties.$pathname])).toEqual([["$pageview", "/series/1"]]);
    expect(since(signedOut)[0]!.properties.distinct_id).not.toBe("user_a");

    const reloaded = events.length;
    await openPage("/series/2", ANONYMOUS);
    expect(since(reloaded).map((e) => [e.event, e.properties.$pathname])).toEqual([["$pageview", "/series/2"]]);
  });

  it("opts back in for a signed-out visit when an earlier load stored the opt-out", async () => {
    // Signed in to an opted-out account from anonymous browsing: the
    // opt-out is stored under the anonymous id. Later loads are signed out.
    const page = await openPage("/", ANONYMOUS);
    const anonymousId = page.posthog.get_distinct_id();
    await page.apply(PENDING);
    await page.apply(OFF);
    const reloaded = events.length;
    await openPage("/series/2", ANONYMOUS);
    expect(since(reloaded).map((e) => [e.event, e.properties.distinct_id, e.properties.$pathname])).toEqual([
      ["$pageview", anonymousId, "/series/2"],
    ]);
  });

  it("never sends under one account's id after another signs in, and never merges them", async () => {
    const page = await openPage("/", identified("user_a"));
    await page.go("/series/1");
    const switched = events.length;
    await page.apply(PENDING);
    await page.go("/series/2");
    await page.apply(identified("user_b"));
    await page.go("/series/3");
    expect(named(since(switched))).toEqual([
      ["$identify", "user_b"],
      ["$pageview", "user_b"],
    ]);

    const reloaded = events.length;
    await openPage("/series/4", identified("user_b"));
    expect(named(since(reloaded))).toEqual([
      ["$pageview", "user_b"],
      ["$set", "user_b"],
    ]);
    for (const event of since(switched)) expect(event.properties.distinct_id).toBe("user_b");
    for (const event of events) expect(event.properties.$anon_distinct_id).not.toBe("user_a");
  });

  it("forgets a remembered account on a later load as another account", async () => {
    await openPage("/", identified("user_a"));
    const reloaded = events.length;
    await openPage("/series/1", identified("user_b"));
    const sent = since(reloaded);
    expect(named(sent)).toEqual([
      ["$identify", "user_b"],
      ["$pageview", "user_b"],
    ]);
    for (const event of sent) expect(event.properties.$anon_distinct_id).not.toBe("user_a");
  });

  it("sends the initial pageview once when a page that loaded pending forgets a remembered account for another", async () => {
    await openPage("/", identified("user_a"));
    const reloaded = events.length;
    const page = await openPage("/series/1", PENDING);
    await page.apply(identified("user_b"));
    await page.go("/series/2");

    const sent = since(reloaded);
    const anonymousId = sent.find((e) => e.event === "$identify")?.properties.$anon_distinct_id;
    expect(anonymousId).not.toBe("user_a");
    // The initial pageview goes out under the id reset() made, which $identify links to user_b.
    const expected = [
      ["$pageview", anonymousId, "/series/1"],
      ["$identify", "user_b", "/series/1"],
      ["$pageview", "user_b", "/series/2"],
    ];
    const received = sent.map((e) => [e.event, e.properties.distinct_id, e.properties.$pathname]);
    expect(received).toHaveLength(expected.length);
    expect(received).toEqual(expect.arrayContaining(expected));
  });

  it("sends the initial pageview once when a page that loaded pending forgets a remembered account on sign-out", async () => {
    await openPage("/", identified("user_a"));
    const reloaded = events.length;
    const page = await openPage("/series/1", PENDING);
    await page.apply(ANONYMOUS);
    await page.go("/series/2");

    const sent = since(reloaded);
    const anonymousId = page.posthog.get_distinct_id();
    expect(anonymousId).not.toBe("user_a");
    expect(sent.map((e) => [e.event, e.properties.distinct_id, e.properties.$pathname])).toEqual([
      ["$pageview", anonymousId, "/series/1"],
      ["$pageview", anonymousId, "/series/2"],
    ]);
  });

  it("sends nothing while off when another tab opts the browser back in", async () => {
    const page = await openPage("/", ANONYMOUS);
    const switched = requests.length;
    await page.apply(OFF);
    // posthog-js keeps its consent in localStorage, shared by every tab.
    localStorage.setItem("__ph_opt_in_out_phc_test", "1");
    await page.go(`/series/${OFF_TIME}`);
    expect(requests.slice(switched)).toEqual([]);
  });

  it("links anonymous browsing to the account it signs in to, once", async () => {
    const page = await openPage("/", ANONYMOUS);
    await page.go("/series/1");
    const anonymousId = page.posthog.get_distinct_id();
    await page.apply(PENDING);
    await page.go("/me");
    await page.apply(identified("user_a"));
    await page.apply(identified("user_a"));
    await page.go("/series/2");

    expect(events.map((e) => [e.event, e.properties.distinct_id])).toEqual([
      ["$pageview", anonymousId],
      ["$pageview", anonymousId],
      ["$identify", "user_a"],
      ["$pageview", "user_a"],
    ]);
    expect(events[2]!.properties.$anon_distinct_id).toBe(anonymousId);
    // The page visited before the account's preference answered is not recorded.
    expect(events[3]!.properties.$prev_pageview_pathname).toBe("/series/1");
  });

  it("sends nothing under Do Not Track, whatever the account says", async () => {
    Object.defineProperty(navigator, "doNotTrack", { configurable: true, value: "1" });
    const page = await openPage("/", identified("user_a"));
    await page.go("/series/1");
    await page.apply(OFF);
    await page.apply(identified("user_a"));
    await page.apply(ANONYMOUS);
    await page.go("/series/2");
    await openPage("/series/3", ANONYMOUS);
    expect(requests).toEqual([]);
  });
});
