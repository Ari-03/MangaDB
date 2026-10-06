import { ConvexError } from "convex/values";
import type { QueryCtx } from "../_generated/server";
import { toIsbn13 } from "./isbn";
import { takeWithin, budgetShortfall } from "./releaseIsbns";

/** Parse citations only. An accepted URL is not a contents determination. */
export function evidenceUrls(urls: string[]): string[] {
  if (urls.length === 0 || urls.length > 12) throw new ConvexError("Supply 1–12 evidence URLs.");
  const normalized = [
    ...new Set(
      urls.map((text) => {
        const trimmed = text.trim();
        if (trimmed.length > 4000) throw new ConvexError("Evidence URL exceeds 4000 characters.");
        let url: URL;
        try {
          url = new URL(trimmed);
        } catch {
          throw new ConvexError("Evidence needs an absolute HTTP(S) URL with a host.");
        }
        if (!["http:", "https:"].includes(url.protocol) || !url.hostname)
          throw new ConvexError("Evidence needs an absolute HTTP(S) URL with a host.");
        return trimmed;
      }),
    ),
  ];
  if (new TextEncoder().encode(normalized.join("\n")).length > 48 * 1024)
    throw new ConvexError("Evidence citations exceed 48 KiB.");
  return normalized;
}

/** Exact ISBN decisions, including revoked history. Overflow is unknown and blocks a write. */
export async function scopeState(ctx: QueryCtx, isbn: string) {
  const isbn13 = toIsbn13(isbn);
  if (!isbn13) throw new ConvexError("Supply a valid ISBN.");
  // These rows are created only through 12 citations of at most 4000 chars.
  // Reserve their bounded payload rather than a catalog snapshot's 1 MiB.
  const room = async () => {
    const short = budgetShortfall(await ctx.meta.getTransactionMetrics(), {
      bytesRead: 192 * 1024,
      bytesWritten: 128 * 1024,
      databaseQueries: 9,
      documentsRead: 9,
      documentsWritten: 8,
    });
    if (short.length) throw new Error(`Scope history transaction incomplete: ${short.join(", ")}.`);
  };
  const rows = await takeWithin(
    ctx.db.query("scopeDecisions").withIndex("by_isbn13", (q) => q.eq("isbn13", isbn13)),
    21,
    room,
  );
  if (rows.some((row) => new TextEncoder().encode(JSON.stringify(row)).length > 64 * 1024))
    throw new Error("Scope decision exceeds its 64 KiB payload contract; incomplete.");
  if (rows.length > 20)
    throw new ConvexError("Scope history is incomplete: an administrator inspects this ISBN.");
  const active = rows.filter((row) => row.revokedAt === undefined);
  if (active.length > 1)
    throw new ConvexError("Multiple active scope decisions: correct before placement.");
  return { isbn13, rows, active: active[0] ?? null };
}

/** Normalized exact-ISBN scope. No publisher-family or title-family ban. */
export async function isbnScope(ctx: QueryCtx, isbn: string | undefined): Promise<string | null> {
  if (!isbn || !toIsbn13(isbn)) return null;
  const state = await scopeState(ctx, isbn);
  if (state.active) return `Reviewed exact ISBN ${state.isbn13}: ${state.active.reason}`;
  const yen = await ctx.db
    .query("sourceObservations")
    .withIndex("by_source_record", (q) =>
      q.eq("sourceKey", "yenpress").eq("sourceRecordId", state.isbn13),
    )
    .unique();
  const reason = (yen?.snapshot as { outOfScope?: string } | undefined)?.outOfScope;
  return !yen?.withdrawn && reason ? `Yen Press (${reason})` : null;
}
