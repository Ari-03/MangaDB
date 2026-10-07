import { describe, expect, test } from "vitest";

import { authEnds, authStarts, recordCoverCheck, timed, timeRequest } from "./timing";

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
/** The Server-Timing metrics of `response`, one string per metric. */
const metrics = (response: Response) =>
  (response.headers.get("Server-Timing") ?? "").split(", ").filter(Boolean);
const names = (response: Response) => metrics(response).map((metric) => metric.split(";")[0]);

/** A body that sends "one", then "two" once read again; `cancelled` resolves with a cancel's reason. */
function streamingBody() {
  let cancelled!: (reason: unknown) => void;
  const cancel = new Promise<unknown>((resolve) => {
    cancelled = resolve;
  });
  const parts = ["one", "two"];
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const part = parts.shift();
      if (part) controller.enqueue(new TextEncoder().encode(part));
      else controller.close();
    },
    cancel: (reason) => cancelled(reason),
  });
  return { body, cancel };
}

/** `response` with headers that refuse changes, as a fetch() answer's do in the Worker. */
function immutable(response: Response): Response {
  response.headers.append = () => {
    throw new TypeError("immutable headers");
  };
  return response;
}

describe("timeRequest", () => {
  test("adds the app span, with one decimal, to the response", async () => {
    const response = await timeRequest(async () => new Response("ok"));
    expect(metrics(response)).toEqual([expect.stringMatching(/^app;dur=\d+\.\d$/)]);
    expect(await response.text()).toBe("ok");
  });

  test("names spans and outcomes from fixed words, and counts as integers", async () => {
    const response = await timeRequest(async () => {
      await timed("cat", async () => tick());
      recordCoverCheck(12.345, "failed", 3);
      return new Response("ok");
    });
    expect(metrics(response)).toEqual([
      expect.stringMatching(/^cat;dur=\d+\.\d$/),
      'cov;dur=12.3;desc="failed"',
      'covr2;desc="3"',
      expect.stringMatching(/^app;dur=\d+\.\d$/),
    ]);
  });

  test("bounds a count to a non-negative integer", async () => {
    const response = await timeRequest(async () => {
      recordCoverCheck(-4, "complete", 2.7);
      recordCoverCheck(1, "complete", -5);
      return new Response("ok");
    });
    expect(metrics(response).slice(0, 4)).toEqual([
      'cov;dur=0.0;desc="complete"',
      'covr2;desc="2"',
      'cov;dur=1.0;desc="complete"',
      'covr2;desc="0"',
    ]);
  });

  test("an unbound cover check has no head count", async () => {
    const response = await timeRequest(async () => {
      recordCoverCheck(0, "unbound", 0);
      return new Response("ok");
    });
    expect(names(response)).toEqual(["cov", "app"]);
  });

  test("keeps an existing Server-Timing value", async () => {
    const response = await timeRequest(
      async () => new Response("ok", { headers: { "Server-Timing": "cfExtPri" } }),
    );
    expect(metrics(response)[0]).toBe("cfExtPri");
    expect(names(response)).toEqual(["cfExtPri", "app"]);
  });

  test("an auth span runs from the middleware before Clerk to the one after", async () => {
    const response = await timeRequest(async () => {
      await tick(5); // framework setup before the middleware chain: not auth
      authStarts();
      await tick(1);
      authEnds();
      return new Response("ok");
    });
    const auth = metrics(response).find((metric) => metric.startsWith("auth;"));
    const app = metrics(response).find((metric) => metric.startsWith("app;"));
    expect(Number(auth?.split("=")[1])).toBeLessThan(Number(app?.split("=")[1]));
  });

  test("Clerk handing nothing on (a handshake redirect) leaves no auth span", async () => {
    const response = await timeRequest(async () => {
      authStarts();
      return Response.redirect("https://clerk.example/handshake", 307);
    });
    expect(names(response)).toEqual(["app"]);
  });

  test("keeps every cookie, the status and the headers", async () => {
    const headers = new Headers({
      "Content-Type": "text/html",
      "X-Clerk-Auth-Status": "signed-out",
    });
    headers.append("Set-Cookie", "a=1; Path=/");
    headers.append("Set-Cookie", "b=2; Path=/; HttpOnly");
    const response = await timeRequest(
      async () => new Response("ok", { status: 201, statusText: "Made", headers }),
    );
    expect(response.status).toBe(201);
    expect(response.statusText).toBe("Made");
    expect(response.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/; HttpOnly"]);
    expect(response.headers.get("X-Clerk-Auth-Status")).toBe("signed-out");
  });

  test("copies a response whose headers can't change, keeping it whole", async () => {
    const headers = new Headers({ "Server-Timing": "cfL4" });
    headers.append("Set-Cookie", "a=1");
    headers.append("Set-Cookie", "b=2");
    const response = await timeRequest(async () =>
      immutable(new Response("ok", { status: 202, headers })),
    );
    expect(response.status).toBe(202);
    expect(response.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
    expect(names(response)).toEqual(["cfL4", "app"]);
    expect(await response.text()).toBe("ok");
  });

  test("a redirect keeps its status and Location", async () => {
    const response = await timeRequest(async () =>
      Response.redirect("https://mangadb.org/sign-in", 307),
    );
    expect(response.status).toBe(307);
    expect(response.headers.get("Location")).toBe("https://mangadb.org/sign-in");
    expect(names(response)).toEqual(["app"]);
  });

  for (const [kind, wrap] of [
    ["mutable", (response: Response) => response],
    ["immutable", immutable],
  ] as const) {
    test(`streams the body as it comes, and passes a cancel on (${kind} headers)`, async () => {
      const first = streamingBody();
      const streamed = await timeRequest(async () => wrap(new Response(first.body)));
      expect(await streamed.text()).toBe("onetwo");

      const second = streamingBody();
      const cancelled = await timeRequest(async () => wrap(new Response(second.body)));
      const reader = cancelled.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe("one");
      await reader.cancel("visitor left");
      expect(await second.cancel).toBe("visitor left");
    });
  }

  test("passes an error through, without a response", async () => {
    const failure = new Error("render failed");
    await expect(
      timeRequest(async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
  });

  test("drops spans recorded after the response is built", async () => {
    let background: Promise<void> | undefined;
    const response = await timeRequest(async () => {
      background = tick(5).then(() => recordCoverCheck(1, "complete", 9));
      return new Response("ok");
    });
    await background;
    expect(names(response)).toEqual(["app"]);
  });

  test("keeps concurrent requests' spans apart", async () => {
    const request = (heads: number, wait: number) =>
      timeRequest(async () => {
        authStarts();
        await tick(wait);
        authEnds();
        await timed("cat", async () => {
          await Promise.resolve();
          await tick(wait);
        });
        recordCoverCheck(1, "complete", heads);
        return new Response(String(heads));
      });
    const [slow, fast] = await Promise.all([request(3, 6), request(7, 1)]);
    for (const [response, heads] of [
      [slow, 3],
      [fast, 7],
    ] as const) {
      expect(names(response)).toEqual(["auth", "cat", "cov", "covr2", "app"]);
      expect(metrics(response)).toContain(`covr2;desc="${heads}"`);
    }
  });
});

describe("outside a request", () => {
  test("records nothing and still runs the work", async () => {
    authStarts();
    authEnds();
    recordCoverCheck(1, "complete", 1);
    expect(await timed("cat", async () => 42)).toBe(42);
  });
});
