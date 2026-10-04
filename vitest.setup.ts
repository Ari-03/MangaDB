// Runs before every test file (vitest.config.ts setupFiles): no test may
// reach the network. An unstubbed fetch gets a 400 refusal instead of the
// real fetch. vi.stubGlobal("fetch", …) stubs over it and
// vi.unstubAllGlobals() restores the refusal, so work a test leaves
// scheduled (a page pass on a zero-delay timer) can never send a real
// request from whichever test is running when it fires. A 400 and not a
// throw: politeFetch (convex/lib/http.ts) retries a thrown error with real
// sleeps but gives up on a 4xx at once, so a stray pass ends at once.

import type { IFetchInterceptor } from "happy-dom";

const REFUSAL = "no fetch stub installed";

globalThis.fetch = async () => new Response(REFUSAL, { status: 400 });

// WebSocket, the Convex React client's transport: no test opens one, and
// one that tries gets this error.
Object.defineProperty(globalThis, "WebSocket", {
  configurable: true,
  writable: true,
  value: class {
    constructor() {
      throw new Error("no WebSocket stub installed");
    }
  },
});

// happy-dom's XMLHttpRequest, navigator.sendBeacon and page resource loads
// (stylesheets, iframes) go through its own fetch, not the global one; its
// fetch interceptor refuses them all. It loads no scripts by default.
const happyDOM: unknown = Reflect.get(globalThis, "happyDOM");
if (happyDOM !== undefined) {
  const { DetachedWindowAPI } = await import("happy-dom");
  if (!(happyDOM instanceof DetachedWindowAPI)) {
    throw new Error("happy-dom's window API is not where vitest.setup.ts expects it");
  }
  const refuse: IFetchInterceptor = {
    beforeAsyncRequest: async ({ window }) => new window.Response(REFUSAL, { status: 400 }),
    beforeSyncRequest: ({ request, window }) => ({
      status: 400,
      statusText: "Bad Request",
      ok: false,
      url: request.url,
      redirected: false,
      headers: new window.Headers(),
      body: Buffer.from(REFUSAL),
    }),
  };
  happyDOM.settings.fetch.interceptor = refuse;
}
