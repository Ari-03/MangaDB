// Convex lets one function have at most 1,000 I/O operations in flight
// (https://docs.convex.dev/production/state/limits). A query that joins every
// row at once (Promise.all over a month's Releases, a long Series' Editions)
// passes that on a busy month or a long run, so its reads share one queue.

/** Reads one query keeps in flight at most: well under Convex's 1,000. */
export const READ_CONCURRENCY = 256;

// The calls that read: db and query builders, a query's async iterator,
// storage. Every other method builds a query, and what it returns is bounded
// in turn.
const READS = new Set<PropertyKey>([
  "get",
  "collect",
  "take",
  "first",
  "unique",
  "paginate",
  "next",
  "getUrl",
  "getMetadata",
]);

// The dbs boundedReads made, so bounding a ctx twice keeps the one queue.
const bounded = new WeakSet<object>();

/**
 * `ctx` with its `db` and `storage` reads behind one queue: at most
 * READ_CONCURRENCY in flight, the rest started in the order asked as
 * earlier ones finish. Results and their order are untouched, only when a
 * read starts changes, so a Promise.all join keeps its round trips few
 * without passing the limit, however wide its nested fan-out. A ctx already bounded is returned as is,
 * so helpers can bound what they are passed and still share the caller's
 * queue. Reads are leaves (no read waits on another), so the queue never
 * deadlocks.
 */
export function boundedReads<Ctx extends { db: object; storage: object }>(ctx: Ctx): Ctx {
  if (bounded.has(ctx.db)) return ctx;
  const slot = limiter(READ_CONCURRENCY);
  // Builders (and `db.system`) are bounded in turn; a promise from a call
  // that is not a read (a mutation's write) passes through as it is.
  const boundIfBuilder = (out: unknown) =>
    out !== null && typeof out === "object" && !(out instanceof Promise) ? wrap(out) : out;
  const wrap = <T extends object>(target: T): T =>
    new Proxy(target, {
      get(on, prop) {
        const value: unknown = Reflect.get(on, prop, on);
        if (typeof value !== "function") return boundIfBuilder(value);
        if (READS.has(prop))
          return (...args: unknown[]) => slot((): unknown => value.apply(on, args));
        return (...args: unknown[]) => boundIfBuilder(value.apply(on, args));
      },
    });
  const db = wrap(ctx.db);
  bounded.add(db);
  return { ...ctx, db, storage: wrap(ctx.storage) };
}

/**
 * Run async work at most `cap` at a time, first come first served. A
 * finishing run hands its slot straight to the next waiter, so a newcomer
 * can never slip in between and push the count past `cap`.
 */
function limiter(cap: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <T>(run: () => T): Promise<Awaited<T>> => {
    if (active < cap) active++;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await run();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}
