// The Approved Source registry (ticket #34, spec §6): registry rows are
// data, not code — a source's scope, per-field authority map, cadence,
// enablement, and attribution are all editable through `upsert` (or the
// Convex dashboard) with no schema or code change. Adapters are the only
// code half: a registry row without an adapter simply never runs.
//
// Bootstrap Mode (spec §7) also lives here: the singleton appConfig toggle
// that lifts the always-review creation gates pre-launch. It defaults OFF —
// steady-state rules — and is switched off permanently before launch.

import { ConvexError, v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { requireModerator, requireRole } from "./lib/roles";

const authorityLevel = v.union(
  v.literal("authoritative"),
  v.literal("standard"),
  v.literal("weak"),
);

const fieldAuthority = v.record(v.string(), authorityLevel);

// The v1 authority table from spec §6, as seed data. `seedRegistry` only
// inserts missing keys — it never overwrites a row an Administrator edited
// (existing deployments flip sources on via `upsert` or the dashboard).
// All five v1 adapters exist (tickets #34/#36), so every row seeds enabled;
// PRH and OpenLibrary additionally need environment configuration (API
// key/imprints, filtered-dump URL — see README) and skip gracefully as
// "unconfigured" until it is set. The `price` column extends the spec table
// as plain registry data (that's the point of the registry): own-catalog
// publishers and the distributor API are authoritative for their own list
// prices; ANN/OpenLibrary have none.
export const V1_SOURCE_DEFAULTS = [
  {
    key: "sevenseas",
    name: "Seven Seas Entertainment",
    enabled: true,
    scope: "Seven Seas' own catalog",
    fieldAuthority: {
      date: "authoritative",
      isbn: "authoritative",
      titles: "authoritative",
      creators: "authoritative",
      format: "authoritative",
      price: "authoritative",
    },
    cadence: "daily",
    attribution: "Cover and publication data courtesy of Seven Seas Entertainment (sevenseasentertainment.com).",
  },
  {
    key: "kodansha",
    name: "Kodansha USA",
    enabled: true,
    scope: "Kodansha's own catalog",
    fieldAuthority: {
      date: "authoritative",
      isbn: "authoritative",
      titles: "authoritative",
      creators: "authoritative",
      format: "authoritative",
      price: "authoritative",
    },
    cadence: "daily",
    attribution: "Cover and publication data courtesy of Kodansha (kodansha.us).",
  },
  {
    key: "prh",
    name: "Penguin Random House API",
    enabled: true,
    scope: "PRH-distributed publishers",
    fieldAuthority: {
      date: "authoritative",
      isbn: "authoritative",
      titles: "standard",
      creators: "standard",
      format: "standard",
      price: "authoritative",
    },
    cadence: "daily",
    attribution: "Publication data via the Penguin Random House API.",
  },
  {
    key: "ann",
    name: "Anime News Network Encyclopedia",
    enabled: true,
    scope: "All English releases",
    fieldAuthority: {
      date: "standard",
      titles: "standard",
      creators: "standard",
      format: "standard",
    },
    cadence: "weekly",
    attribution: "Encyclopedia data provided by Anime News Network.",
  },
  {
    key: "openlibrary",
    name: "OpenLibrary",
    enabled: true,
    scope: "All English releases",
    fieldAuthority: {
      date: "weak",
      isbn: "standard",
      titles: "weak",
      creators: "weak",
      format: "standard",
    },
    cadence: "monthly",
    attribution: "Bibliographic data from OpenLibrary (openlibrary.org), CC0.",
  },
] as const;

export async function getSourceByKey(
  ctx: QueryCtx | MutationCtx,
  key: string,
) {
  return await ctx.db
    .query("approvedSources")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique();
}

/**
 * Seed the registry with the spec §6 defaults, inserting only keys that do
 * not exist yet. Safe to re-run; never undoes an edit.
 *
 *   npx convex run importSources:seedRegistry '{}'
 */
export const seedRegistry = internalMutation({
  args: {},
  handler: async (ctx) => {
    const inserted: string[] = [];
    for (const source of V1_SOURCE_DEFAULTS) {
      if (await getSourceByKey(ctx, source.key)) continue;
      await ctx.db.insert("approvedSources", {
        ...source,
        fieldAuthority: { ...source.fieldAuthority },
        healthState: "healthy",
        consecutiveFailures: 0,
      });
      inserted.push(source.key);
    }
    return { inserted };
  },
});

/** The registry, for the data-team dashboard view. */
export const list = query({
  args: {},
  handler: async (ctx) => {
    await requireModerator(ctx);
    const sources = await ctx.db.query("approvedSources").collect();
    return sources.sort((a, b) => a.key.localeCompare(b.key));
  },
});

export const getByKey = internalQuery({
  args: { key: v.string() },
  handler: async (ctx, { key }) => await getSourceByKey(ctx, key),
});

/**
 * Add or edit a registry row — the "no code change" path of spec §6.
 * Administrator-gated; adjusting scope, the authority map, cadence,
 * attribution, or enablement is a plain data write.
 */
export const upsert = mutation({
  args: {
    key: v.string(),
    name: v.string(),
    enabled: v.boolean(),
    scope: v.string(),
    fieldAuthority,
    cadence: v.string(),
    attribution: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireRole(ctx, ["administrator"]);
    const key = args.key.trim().toLowerCase();
    if (!/^[a-z][a-z0-9-]*$/.test(key)) {
      throw new ConvexError({
        code: "invalidKey",
        message: "Source keys are lowercase slugs (e.g. \"sevenseas\").",
      });
    }
    const existing = await getSourceByKey(ctx, key);
    const row = {
      name: args.name.trim(),
      enabled: args.enabled,
      scope: args.scope.trim(),
      fieldAuthority: args.fieldAuthority,
      cadence: args.cadence.trim().toLowerCase(),
      attribution: args.attribution?.trim() || undefined,
    };
    if (existing) {
      await ctx.db.patch(existing._id, row);
      return existing._id;
    }
    return await ctx.db.insert("approvedSources", {
      key,
      ...row,
      healthState: "healthy",
      consecutiveFailures: 0,
    });
  },
});

// ---------- health (spec §6: runs & failure) ----------

/**
 * Record a run outcome on the source: three consecutive failures flip it
 * unhealthy (dashboard flag; the Admin email on transition needs a live
 * email provider and is wired when one exists), the first success flips it
 * back and resets the streak.
 */
export async function recordSourceOutcome(
  ctx: MutationCtx,
  sourceKey: string,
  ok: boolean,
): Promise<void> {
  const source = await getSourceByKey(ctx, sourceKey);
  if (!source) return;
  if (ok) {
    if (source.healthState === "unhealthy") {
      console.warn(`[imports] source "${sourceKey}" recovered — healthy again`);
    }
    await ctx.db.patch(source._id, {
      healthState: "healthy",
      consecutiveFailures: 0,
    });
    return;
  }
  const failures = source.consecutiveFailures + 1;
  const unhealthy = failures >= 3;
  if (unhealthy && source.healthState === "healthy") {
    console.error(
      `[imports] source "${sourceKey}" is unhealthy after ${failures} consecutive failures`,
    );
  }
  await ctx.db.patch(source._id, {
    consecutiveFailures: failures,
    healthState: unhealthy ? "unhealthy" : source.healthState,
  });
}

// ---------- Bootstrap Mode (spec §7) ----------

/** The singleton appConfig row's toggle; absent config means steady-state. */
export async function getBootstrapMode(
  ctx: QueryCtx | MutationCtx,
): Promise<boolean> {
  const config = await ctx.db.query("appConfig").first();
  return config?.bootstrapMode ?? false;
}

export const bootstrapStatus = query({
  args: {},
  handler: async (ctx) => {
    await requireModerator(ctx);
    return { bootstrapMode: await getBootstrapMode(ctx) };
  },
});

/**
 * Flip Bootstrap Mode (Administrator). Pre-launch seeding turns it on;
 * before launch it is switched off permanently (spec §7).
 */
export const setBootstrapMode = mutation({
  args: { on: v.boolean() },
  handler: async (ctx, { on }) => {
    await requireRole(ctx, ["administrator"]);
    await writeBootstrapMode(ctx, on);
  },
});

/**
 * Operator escape hatch for dev/seeding before any Administrator exists:
 *   npx convex run importSources:setBootstrapModeInternal '{"on":true}'
 */
export const setBootstrapModeInternal = internalMutation({
  args: { on: v.boolean() },
  handler: async (ctx, { on }) => {
    await writeBootstrapMode(ctx, on);
  },
});

async function writeBootstrapMode(ctx: MutationCtx, on: boolean) {
  const config = await ctx.db.query("appConfig").first();
  if (config) await ctx.db.patch(config._id, { bootstrapMode: on });
  else await ctx.db.insert("appConfig", { bootstrapMode: on });
}
