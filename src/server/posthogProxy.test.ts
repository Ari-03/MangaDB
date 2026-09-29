import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { posthogProxyResponse } from "./posthogProxy";

type Upstream = { url: string; init?: RequestInit };

let calls: Upstream[];
let cached: Map<string, Response>;
beforeEach(() => {
  calls = [];
  cached = new Map();
  vi.stubGlobal("caches", {
    default: {
      match: async (req: Request) => cached.get(req.url),
      put: async (req: Request, res: Response) => void cached.set(req.url, res),
    },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response("upstream", { status: 200 });
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
    expect(new TextDecoder().decode(calls[0]!.init?.body as ArrayBuffer)).toBe("batch");
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
});
