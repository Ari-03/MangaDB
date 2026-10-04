import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { posthogProxyResponse } from "./posthogProxy";
import { stubEdgeCache } from "./test.cache";

type Upstream = { url: string; init?: RequestInit };

let calls: Upstream[];
let cached: Map<string, Response>;
let upstreamStatus: number;
beforeEach(() => {
  calls = [];
  cached = stubEdgeCache();
  upstreamStatus = 200;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response("upstream", { status: upstreamStatus });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("posthogProxyResponse", () => {
  it("ignores every other path", async () => {
    expect(await posthogProxyResponse(new Request("https://mangadb.org/series"))).toBeNull();
    expect(await posthogProxyResponse(new Request("https://mangadb.org/_stats"))).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("forwards ingest requests with method, body and query string", async () => {
    const res = await posthogProxyResponse(
      new Request("https://mangadb.org/_s/e/?ip=0&ver=1.434.17", {
        method: "POST",
        body: "batch",
        headers: { "Content-Type": "text/plain" },
      }),
    );
    expect(await res?.text()).toBe("upstream");
    expect(calls[0]!.url).toBe("https://us.i.posthog.com/e/?ip=0&ver=1.434.17");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(await new Response(calls[0]!.init?.body).text()).toBe("batch");
  });

  it("strips cookies and auth, and forwards the visitor IP", async () => {
    await posthogProxyResponse(
      new Request("https://mangadb.org/_s/flags/?v=2", {
        headers: {
          cookie: "__session=secret",
          authorization: "Bearer x",
          "CF-Connecting-IP": "203.0.113.7",
        },
      }),
    );
    const headers = new Headers(calls[0]!.init?.headers);
    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("x-forwarded-for")).toBe("203.0.113.7");
    expect(calls[0]!.init?.body).toBeNull();
  });

  it("serves static and remote-config paths from the asset host, cached", async () => {
    const req = () => new Request("https://mangadb.org/_s/static/array.js");
    await posthogProxyResponse(req());
    expect(calls[0]!.url).toBe("https://us-assets.i.posthog.com/static/array.js");
    await posthogProxyResponse(req());
    expect(calls).toHaveLength(1);

    await posthogProxyResponse(new Request("https://mangadb.org/_s/array/phc_x/config.js"));
    expect(calls[1]!.url).toBe("https://us-assets.i.posthog.com/array/phc_x/config.js");
  });

  it("forwards non-GET asset requests uncached", async () => {
    const res = await posthogProxyResponse(
      new Request("https://mangadb.org/_s/static/array.js", { method: "POST", body: "x" }),
    );
    expect(res?.status).toBe(200);
    expect(calls[0]!.url).toBe("https://us-assets.i.posthog.com/static/array.js");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(cached.size).toBe(0);
  });

  it("leaves bare /_s to the app", async () => {
    expect(await posthogProxyResponse(new Request("https://mangadb.org/_s"))).toBeNull();
    expect(await posthogProxyResponse(new Request("https://mangadb.org/_s?x=1"))).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("passes upstream errors through, and never caches them", async () => {
    upstreamStatus = 503;
    expect(
      (
        await posthogProxyResponse(
          new Request("https://mangadb.org/_s/e/", { method: "POST", body: "b" }),
        )
      )?.status,
    ).toBe(503);
    const asset = () => posthogProxyResponse(new Request("https://mangadb.org/_s/static/array.js"));
    expect((await asset())?.status).toBe(503);
    expect(cached.size).toBe(0);
    upstreamStatus = 200;
    expect((await asset())?.status).toBe(200);
    expect(calls).toHaveLength(3);
  });

  it("drops a client-sent X-Forwarded-For when Cloudflare gave no IP", async () => {
    await posthogProxyResponse(
      new Request("https://mangadb.org/_s/flags/?v=2", {
        headers: { "X-Forwarded-For": "198.51.100.9" },
      }),
    );
    expect(new Headers(calls[0]!.init?.headers).get("x-forwarded-for")).toBeNull();

    await posthogProxyResponse(
      new Request("https://mangadb.org/_s/flags/?v=2", {
        headers: { "X-Forwarded-For": "198.51.100.9", "CF-Connecting-IP": "203.0.113.7" },
      }),
    );
    expect(new Headers(calls[1]!.init?.headers).get("x-forwarded-for")).toBe("203.0.113.7");
  });

  it("streams an upload upstream instead of buffering it first", async () => {
    // A body whose sender is still uploading: one chunk arrived, no end yet.
    let sender!: ReadableStreamDefaultController<Uint8Array>;
    const upload = new ReadableStream<Uint8Array>({ start: (c) => void (sender = c) });
    sender.enqueue(new TextEncoder().encode("first,"));
    const request = new Request("https://mangadb.org/_s/s/", {
      method: "POST",
      body: upload,
      // Node's Request needs this for a stream body; not in the DOM typings.
      ...{ duplex: "half" },
    });
    const pending = posthogProxyResponse(request);
    // The upstream request starts while the upload is still open.
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const forwarded = calls[0]!.init?.body;
    expect(forwarded).toBeInstanceOf(ReadableStream);
    sender.enqueue(new TextEncoder().encode("second"));
    sender.close();
    expect(await new Response(forwarded).text()).toBe("first,second");
    expect((await pending)?.status).toBe(200);
  });

  it("refuses an upload declared larger than the analytics bound", async () => {
    const res = await posthogProxyResponse(
      new Request("https://mangadb.org/_s/e/", {
        method: "POST",
        body: "x",
        headers: { "Content-Length": String(21 * 1024 * 1024) },
      }),
    );
    expect(res?.status).toBe(413);
    expect(calls).toHaveLength(0);
  });

  it("cuts off an undeclared-length upload that runs past the bound", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    const upload = new ReadableStream<Uint8Array>({
      pull: (c) => (sent++ < 25 ? c.enqueue(chunk) : c.close()),
    });
    const res = await posthogProxyResponse(
      new Request("https://mangadb.org/_s/e/", {
        method: "POST",
        body: upload,
        ...{ duplex: "half" },
      }),
    );
    expect(res?.status).toBe(200);
    // Byte count on success, so a failure message never prints 25 MB.
    const outcome = await new Response(calls[0]!.init?.body).arrayBuffer().then(
      (bytes) => bytes.byteLength,
      (error: Error) => error.message,
    );
    expect(outcome).toMatch(/too large/);
  });
});
