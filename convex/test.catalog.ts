// Helpers the public-catalog suites share on top of test.factories.ts.
// Two dots in the name keep Convex from deploying it (see test.helpers.ts).

import type { Doc } from "./_generated/dataModel";

/**
 * A Release's `pubDate` from its yyyymmdd sort key, at the precision the key
 * states: 20260800 is August 2026 with the day unknown, 20260000 the year
 * alone (the inverse of lib/dates.ts partialDateSort).
 */
export function pubDate(sort: number): NonNullable<Doc<"releases">["pubDate"]> {
  const year = Math.floor(sort / 10000);
  const month = Math.floor(sort / 100) % 100;
  const day = sort % 100;
  return {
    year,
    ...(month ? { month } : {}),
    ...(day ? { day } : {}),
    sort,
  };
}

/**
 * Batches what is waiting into rounds: everything that asks for the next
 * round before it fires shares it. Counts the rounds and the largest one.
 */
function rounder() {
  let rounds = 0;
  let peak = 0;
  let waiting: Array<() => void> = [];
  const nextRound = () =>
    new Promise<void>((resolve) => {
      waiting.push(resolve);
      if (waiting.length > 1) return;
      setImmediate(() => {
        rounds++;
        peak = Math.max(peak, waiting.length);
        const batch = waiting;
        waiting = [];
        for (const release of batch) release();
      });
    });
  return { nextRound, rounds: () => rounds, peak: () => peak };
}

/**
 * `ctx` with a db (and storage) that charges each awaited read one round
 * trip, and the count. Reads issued together (Promise.all) share a round; a
 * read issued after another resolved takes the next. So `rounds()` is the
 * longest chain of reads a query waits on one after another, which is what
 * a cold Convex query pays for, `peak()` the most reads one round held in
 * flight at once (Convex allows a function 1,000), and `gets` tallies each
 * document id `db.get` asked for.
 */
export function roundTrips<Ctx extends { db: object }>(ctx: Ctx) {
  const { nextRound, rounds, peak } = rounder();
  const gets = new Map<unknown, number>();
  // Wraps every method, and every builder a method returns (query →
  // withIndex → …), so the call that finally reads is charged its round.
  const charged = <T extends object>(target: T): T =>
    new Proxy(target, {
      get(on, prop) {
        const value: unknown = Reflect.get(on, prop, on);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (on === ctx.db && prop === "get") gets.set(args.at(-1), (gets.get(args.at(-1)) ?? 0) + 1);
          const out: unknown = value.apply(on, args);
          if (out instanceof Promise) return nextRound().then(() => out);
          return out !== null && typeof out === "object" ? charged(out) : out;
        };
      },
    });
  const storage =
    "storage" in ctx && ctx.storage !== null && typeof ctx.storage === "object"
      ? charged(ctx.storage)
      : undefined;
  return {
    ctx: { ...ctx, db: charged(ctx.db), ...(storage ? { storage } : {}) },
    rounds,
    peak,
    gets,
  };
}

/** convex-test's syscall entry; every read, write and storage call goes through it. */
type ConvexGlobal = {
  syscall: unknown;
  jsSyscall: unknown;
  asyncSyscall: (op: string, args: string) => Promise<string>;
};

/**
 * Run `body` (a `t.query`, say) with every async syscall held to a shared
 * round, as `roundTrips` charges one ctx, and report the most syscalls in
 * flight at once (`peak`: Convex allows a function 1,000) and the syscalls
 * made. Measured where the runtime meets the backend, so it sees every read
 * however the query reaches it. Not a round-trip count: convex-test makes a
 * syscall per document a query yields, so use `roundTrips` for that.
 * convex-test resolves its global per test (people.test.ts `countWrites`
 * swaps it the same way).
 */
export async function syscallLoad(body: () => Promise<unknown>) {
  const holder = globalThis as unknown as { Convex: ConvexGlobal };
  const real = holder.Convex;
  const { nextRound } = rounder();
  let pending = 0;
  let peak = 0;
  let calls = 0;
  holder.Convex = {
    get syscall() {
      return real.syscall;
    },
    get jsSyscall() {
      return real.jsSyscall;
    },
    get asyncSyscall() {
      const call = real.asyncSyscall;
      return async (op: string, args: string) => {
        calls++;
        pending++;
        peak = Math.max(peak, pending);
        try {
          await nextRound();
          return await call(op, args);
        } finally {
          pending--;
        }
      };
    },
  };
  try {
    await body();
  } finally {
    holder.Convex = real;
  }
  return { peak, calls };
}
