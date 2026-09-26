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
import { internal } from "./_generated/api";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { AuthorityLevel } from "./lib/authority";
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
// Every adapter exists (v1's five, tickets #34/#36, plus Yen Press and the
// Kodansha backlist crawl), so every row seeds enabled;
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
      description: "authoritative",
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
      description: "authoritative",
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
      // Distributor flap copy: the publisher's own site text wins.
      description: "standard",
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
      // Fills a Release's blank ISBN from its ANN line; never overrides.
      isbn: "weak",
      // Plot summaries fill a blank synopsis; any publisher text replaces them.
      description: "weak",
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
      description: "weak",
    },
    cadence: "monthly",
    attribution: "Bibliographic data from OpenLibrary (openlibrary.org), CC0.",
  },
  // Post-v1 (spec §6 candidate, built 2026-09): Yen Press is Hachette-
  // distributed, so no other source covers it. Own-catalog authority, like
  // the other publisher feeds.
  {
    key: "yenpress",
    name: "Yen Press",
    enabled: true,
    scope: "Yen Press' own catalog (Yen Press, Ize Press)",
    fieldAuthority: {
      date: "authoritative",
      isbn: "authoritative",
      titles: "authoritative",
      creators: "authoritative",
      format: "authoritative",
      price: "authoritative",
      description: "authoritative",
    },
    cadence: "daily",
    attribution: "Publication data courtesy of Yen Press (yenpress.com).",
  },
  // The Kodansha back catalog (2026-09): a weekly crawl of kodansha.us'
  // series and volume pages (kodansha.backlistSync). This row carries the
  // crawl's cadence, runs, health, and per-series crawl state; the volumes
  // it reads are observed and reconciled under the "kodansha" row, so that
  // row's authority map (mirrored here) is the one that applies.
  {
    key: "kodansha-backlist",
    name: "Kodansha USA (backlist)",
    enabled: true,
    scope: "Kodansha's full comic catalog (series + volume pages, print and digital ISBNs)",
    fieldAuthority: {
      date: "authoritative",
      isbn: "authoritative",
      titles: "authoritative",
      creators: "authoritative",
      format: "authoritative",
      price: "authoritative",
      description: "authoritative",
    },
    cadence: "weekly",
    attribution: "Publication data courtesy of Kodansha (kodansha.us).",
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

/** Error lines carried into the unhealthy alert email — enough to act on. */
const ALERT_ERROR_LINES = 5;

/**
 * Record a run outcome on the source: three consecutive failures flip it
 * unhealthy, the first success flips it back and resets the streak. Each
 * transition — and only the transition, never a repeat while the state
 * holds — schedules exactly one Administrator alert email (#37,
 * imports.healthAlert): the flip and the scheduling commit atomically in
 * this mutation, and the guards below never fire twice for one state.
 */
export async function recordSourceOutcome(
  ctx: MutationCtx,
  sourceKey: string,
  ok: boolean,
  errors: string[] = [],
): Promise<void> {
  const source = await getSourceByKey(ctx, sourceKey);
  if (!source) return;
  if (ok) {
    if (source.healthState === "unhealthy") {
      console.warn(`[imports] source "${sourceKey}" recovered — healthy again`);
      await ctx.scheduler.runAfter(0, internal.imports.healthAlert, {
        sourceKey,
        transition: "recovered",
        consecutiveFailures: source.consecutiveFailures,
        errors: [],
      });
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
    await ctx.scheduler.runAfter(0, internal.imports.healthAlert, {
      sourceKey,
      transition: "unhealthy",
      consecutiveFailures: failures,
      errors: errors.slice(0, ALERT_ERROR_LINES),
    });
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
 * Give an existing registry row authority over a field category it has none
 * for yet (seedRegistry only inserts missing rows). Never changes a category
 * that is already set, so an Administrator's edit stands.
 *   npx convex run importSources:addFieldAuthorityInternal '{"key":"ann","category":"isbn","level":"weak"}'
 */
export const addFieldAuthorityInternal = internalMutation({
  args: {
    key: v.string(),
    category: v.string(),
    level: v.union(v.literal("authoritative"), v.literal("standard"), v.literal("weak")),
  },
  handler: async (ctx, { key, category, level }) => {
    const source = await getSourceByKey(ctx, key.trim().toLowerCase());
    if (!source) throw new Error(`No source with key "${key}".`);
    const current: Record<string, string | undefined> = source.fieldAuthority;
    if (current[category] !== undefined) return { changed: false };
    await ctx.db.patch(source._id, {
      fieldAuthority: { ...source.fieldAuthority, [category]: level },
    });
    return { changed: true };
  },
});

/**
 * Backfill the categories V1_SOURCE_DEFAULTS gained after a deployment was
 * seeded (seedRegistry only inserts missing rows): each stored default row
 * gets every default category it lacks. A category already set is never
 * changed, so an Administrator's edit stands; missing rows are seedRegistry's.
 *   npx convex run importSources:backfillFieldAuthority '{}'
 */
export const backfillFieldAuthority = internalMutation({
  args: {},
  handler: async (ctx) => {
    const added: Array<{ key: string; category: string; level: AuthorityLevel }> = [];
    for (const source of V1_SOURCE_DEFAULTS) {
      const row = await getSourceByKey(ctx, source.key);
      if (!row) continue;
      const stored: Record<string, AuthorityLevel | undefined> = row.fieldAuthority;
      const missing = Object.entries(source.fieldAuthority).filter(
        ([category]) => stored[category] === undefined,
      );
      if (missing.length === 0) continue;
      await ctx.db.patch(row._id, {
        fieldAuthority: { ...row.fieldAuthority, ...Object.fromEntries(missing) },
      });
      for (const [category, level] of missing) added.push({ key: source.key, category, level });
    }
    return { added };
  },
});

/**
 * Operator escape hatch mirroring setBootstrapModeInternal: toggle a source
 * without an Administrator sign-in (e.g. a source whose site blocks our
 * egress IPs, pending an allowlist request):
 *   npx convex run importSources:setEnabledInternal '{"key":"sevenseas","enabled":false}'
 */
export const setEnabledInternal = internalMutation({
  args: { key: v.string(), enabled: v.boolean() },
  handler: async (ctx, { key, enabled }) => {
    const source = await getSourceByKey(ctx, key.trim().toLowerCase());
    if (!source) throw new Error(`No source with key "${key}".`);
    await ctx.db.patch(source._id, { enabled });
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
