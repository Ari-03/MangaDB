// Shared setup for the convex-test suites: the test backend, signed-in users
// and the Data Team, and the plumbing the import tests share. Catalog rows
// come from test.factories.ts.
//
// The file name has two dots so Convex never deploys it: the bundler's
// entryPoints (node_modules/convex/src/bundler/index.ts) skips any file
// whose name contains more than one dot, which is also why *.test.ts files
// stay out of codegen. It imports vitest and convex-test, which the Convex
// runtime does not have. Vitest's include (**/*.test.ts) never matches it.

import { convexTest, type TestConvexForDataModel } from "convex-test";
import rateLimiterTest from "@convex-dev/rate-limiter/test";
import posthogTest from "@posthog/convex/test";
import { expect, vi } from "vitest";

import { api, internal } from "./_generated/api";
import type { DataModel, Doc, Id } from "./_generated/dataModel";
import schema from "./schema";

// Explicit module map: node_modules may be shared with another checkout,
// whose convex/ directory convex-test would otherwise glob.
const modules = import.meta.glob("./**/*.*s");

type TransactionLimits = Parameters<typeof convexTest>[0]["transactionLimits"];

/**
 * A fresh test backend: the app schema and functions, with the rate-limiter
 * and PostHog components registered (convex.config.ts). Pass
 * `transactionLimits` to enforce Convex's per-transaction read limits.
 */
export function makeT(options: { transactionLimits?: TransactionLimits } = {}) {
  const t = convexTest({ schema, modules, ...options });
  rateLimiterTest.register(t, "rateLimiter");
  posthogTest.register(t, "posthog");
  return t;
}
export type TestT = ReturnType<typeof makeT>;

/** `t` or a `t.withIdentity(...)` accessor: anything that runs functions. */
export type Accessor = TestConvexForDataModel<DataModel>;

// ---------- users and the Data Team ----------

type DataRole = NonNullable<Doc<"users">["role"]>;

/** A test user: the Clerk subject they sign in as, the username they claim, and a Data Team role for seedTeam. */
export type TestUser = { subject: string; username: string; role?: DataRole };

// The cast most suites share. alice is the bootstrapped Administrator and
// appoints bob and carol; dave and the reader have no role.
export const ADMIN = "user_admin";
export const MOD = "user_mod";
export const EDITOR = "user_editor";
export const PLAIN = "user_plain";
export const READER = "user_reader";
export const alice = { subject: ADMIN, username: "alice", role: "administrator" } as const satisfies TestUser;
export const bob = { subject: MOD, username: "bob", role: "moderator" } as const satisfies TestUser;
export const carol = { subject: EDITOR, username: "carol", role: "editor" } as const satisfies TestUser;
export const dave = { subject: PLAIN, username: "dave" } as const satisfies TestUser;
export const reader = { subject: READER, username: "reader" } as const satisfies TestUser;

/** Signed in as `user`, with no username claimed (the pending-claim state). */
export function signedIn(t: TestT, user: Pick<TestUser, "subject">) {
  return t.withIdentity({ subject: user.subject });
}

/** Signs `user` in and claims their username; returns their accessor. Ignores `role`. */
export async function withUser(t: TestT, user: TestUser) {
  const as = signedIn(t, user);
  await as.mutation(api.users.claimUsername, { username: user.username });
  return as;
}

/** Claims each user's username, in order. Roles are left unassigned. */
export async function seedUsers(t: TestT, users: readonly TestUser[]) {
  for (const user of users) await withUser(t, user);
}

/**
 * Claims each user's username in order, bootstraps the first Administrator
 * among them, and has that Administrator appoint every other user with a
 * role, in order. `seedTeam(t, [alice, bob, carol, dave])` is the usual cast.
 */
export async function seedTeam(t: TestT, users: readonly TestUser[]) {
  await seedUsers(t, users);
  const admin = users.find((user) => user.role === "administrator");
  if (!admin) {
    if (users.some((user) => user.role)) throw new Error("seedTeam: roles need an administrator to appoint them");
    return;
  }
  await t.mutation(internal.roles.bootstrapAdministrator, { username: admin.username });
  const asAdmin = signedIn(t, admin);
  for (const user of users) {
    if (user === admin || !user.role) continue;
    await asAdmin.mutation(api.roles.appoint, { username: user.username, role: user.role });
  }
}

/**
 * Purges `subject`'s account as users.deleteAccount would, without the
 * Clerk half: marks their User deleting, then runs purgeUser until the row
 * is gone. What the purge schedules (its own continuations, now no-ops, and
 * the manifest redaction) stays queued for `drain`. A no-op for a subject
 * with no User.
 */
export async function purgeAccount(t: TestT, subject: string) {
  const userId = await t.run(async (ctx) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkSubject", (q) => q.eq("clerkSubject", subject))
      .unique();
    if (user) await ctx.db.patch(user._id, { deletingSince: Date.now() });
    return user?._id ?? null;
  });
  while (userId && (await t.run((ctx) => ctx.db.get(userId)))) {
    await t.mutation(internal.users.purgeUser, { userId });
  }
}

// ---------- import runs ----------

/** Seeds the approved-source registry; a boolean `bootstrap` also turns Bootstrap Mode on or off. */
export async function seedRegistry(t: Accessor, bootstrap?: boolean) {
  await t.mutation(internal.importSources.seedRegistry, {});
  if (bootstrap !== undefined) {
    await t.mutation(internal.importSources.setBootstrapModeInternal, { on: bootstrap });
  }
}

/** Runs every scheduled function, and whatever they schedule, under fake timers; real timers after. */
export async function drain(t: Pick<Accessor, "finishAllScheduledFunctions">) {
  vi.useFakeTimers();
  try {
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  } finally {
    vi.useRealTimers();
  }
}

/**
 * A Release Bundle's memberships in bundle order (by `order`, then
 * creation), each with its Release. Without `bundleId`, the only bundle in
 * the database, asserting there is exactly one.
 */
export async function bundleMembers(t: Accessor, bundleId?: Id<"releaseBundles">) {
  return await t.run(async (ctx) => {
    let id = bundleId;
    if (id === undefined) {
      const bundles = await ctx.db.query("releaseBundles").collect();
      expect(bundles).toHaveLength(1);
      id = bundles[0]!._id;
    }
    const rows = await ctx.db
      .query("bundleMemberships")
      .withIndex("by_bundle", (q) => q.eq("bundleId", id))
      .collect();
    return await Promise.all(
      rows.map(async (row) => {
        const release = await ctx.db.get(row.releaseId);
        if (!release) throw new Error(`bundle member ${row.releaseId} has no Release`);
        return { ...row, release };
      }),
    );
  });
}
