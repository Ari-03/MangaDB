// Server-Timing for app requests: how long a page or server-function request
// spent in each phase, so a slow first byte can be traced to its phase. The
// header carries fixed span names, fixed outcome words and integers only:
// no ids, paths, ISBNs or viewer state.
//
//   app    The Start handler, from the call until it returns its Response
//          (src/server.ts). The body may still be streaming then; time before
//          the Worker reaches our code, and transfer to the browser, are not
//          in it.
//   auth   Clerk's request middleware, from just before it runs until it hands
//          the request on (src/start.ts). Its header work after the handler
//          returns is outside the span; a handshake redirect has no span.
//   cat    The home page's catalog reads in the Worker (routes/index.tsx).
//   cov    Which home candidates have a jacket on file (server/covers.ts), with
//          its outcome; `covr2` is how many R2 heads that check sent. It ends
//          when the check answers: by its 300 ms budget, or as soon after as
//          the Worker runs the timer. Reads still out then, and the check's
//          warm-ups, are not in it.
//
// A Worker's clock advances only across I/O, so these are elapsed times as
// that clock saw them: CPU time between I/O is not reliably in or out of a
// span, and no span measures render CPU (Workers Observability has that).
// Spans recorded after the Response is returned (background work) are
// dropped. HTML is not cached anywhere today; a future HTML cache must drop or
// regenerate this header rather than replay it.
//
// Server-only: import it from server modules, server-function handlers,
// request middleware and createIsomorphicFn().server() only, so it never
// reaches the browser bundle (`npm run build` checks: build/checkPreloads.ts).
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * What a cover check came to: every read it needed answered; all answered but
 * at least one threw; its budget ran out with reads still out or unsent
 * (whether or not one threw); or no bucket bound.
 */
export type CoverOutcome = "complete" | "failed" | "partial" | "unbound";

type Span =
  | { name: "app" | "auth" | "cat"; ms: number }
  | { name: "cov"; ms: number; outcome: CoverOutcome }
  | { name: "covr2"; count: number };

type RequestTiming = { spans: Array<Span>; authStart?: number; sent: boolean };

/** A request's spans; one store per request, so concurrent requests never mix. */
const requests = new AsyncLocalStorage<RequestTiming>();
/** More than any request records today; a bound, not a budget. */
const MAX_SPANS = 16;

/** Add a span to the current request's list; a no-op outside one or once its header is built. */
function record(span: Span): void {
  const timing = requests.getStore();
  if (!timing || timing.sent || timing.spans.length >= MAX_SPANS) return;
  timing.spans.push(span);
}

/**
 * Run the app handler for one request and add its spans to the Response's
 * Server-Timing. A thrown error passes through untouched, without a header.
 */
export function timeRequest(handle: () => Response | Promise<Response>): Promise<Response> {
  const timing: RequestTiming = { spans: [], sent: false };
  return requests.run(timing, async () => {
    const start = performance.now();
    try {
      const response = await handle();
      record({ name: "app", ms: performance.now() - start });
      return withServerTiming(response, timing.spans);
    } finally {
      timing.sent = true;
    }
  });
}

/** `work`'s result, recording how long it took as `name` (on failure too). */
export async function timed<T>(name: "cat", work: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try {
    return await work();
  } finally {
    record({ name, ms: performance.now() - start });
  }
}

/** Request middleware placed just before Clerk's: the auth span starts here. */
export function authStarts(): void {
  const timing = requests.getStore();
  if (timing) timing.authStart = performance.now();
}

/** Request middleware placed just after Clerk's: it handed the request on. */
export function authEnds(): void {
  const start = requests.getStore()?.authStart;
  if (start !== undefined) record({ name: "auth", ms: performance.now() - start });
}

/** A cover check's span and the number of R2 heads it sent. */
export function recordCoverCheck(ms: number, outcome: CoverOutcome, heads: number): void {
  record({ name: "cov", ms, outcome });
  if (outcome !== "unbound") record({ name: "covr2", count: heads });
}

const duration = (ms: number) => (Number.isFinite(ms) ? Math.max(0, ms) : 0).toFixed(1);
const count = (n: number) => String(Math.min(1_000_000, Math.max(0, Math.trunc(n) || 0)));

function metric(span: Span): string {
  switch (span.name) {
    case "cov":
      return `cov;dur=${duration(span.ms)};desc="${span.outcome}"`;
    case "covr2":
      return `covr2;desc="${count(span.count)}"`;
    default:
      return `${span.name};dur=${duration(span.ms)}`;
  }
}

/**
 * `response` with `spans` appended to its Server-Timing; an existing value
 * (Cloudflare adds its own) is kept. The response itself is returned when its
 * headers can change, so status, cookies and a streaming body are untouched.
 * One with immutable headers (Response.redirect, a fetch() answer) is copied
 * around the same body.
 */
function withServerTiming(response: Response, spans: ReadonlyArray<Span>): Response {
  if (spans.length === 0) return response;
  const value = spans.map(metric).join(", ");
  try {
    response.headers.append("Server-Timing", value);
    return response;
  } catch {
    const copy = new Response(response.body, response);
    copy.headers.append("Server-Timing", value);
    return copy;
  }
}
