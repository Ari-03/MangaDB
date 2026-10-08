// Scheduled jobs (spec §6): one hourly tick reads the Approved Source
// registry and starts every enabled source that is due per its cadence —
// so cadence stays data (registry rows), not cron code. Adapters are
// dispatched by imports.runScheduled.

import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval("import cadence tick", { hours: 1 }, internal.imports.runScheduled, {});

// The /series library reads denormalized per-Series rows (seriesBrowse.ts);
// this refreshes them so counts, dates, and popularity lag the catalog by
// at most this long.
crons.interval("series browse stats", { hours: 6 }, internal.seriesBrowse.rebuild, {});

// Authors and their Series credits, derived from the stored ANN and publisher
// observations (people.ts); they follow each import within six hours.
crons.interval("author credits", { hours: 6 }, internal.people.rebuild, {});

// The Publishers board serves precomputed months (publisher.ts): the months
// around today stay within an hour of the catalog, imports included; the
// rest of the 2025–2028-style window within six hours.
crons.interval("publisher boards near", { hours: 1 }, internal.publisher.rebuildBoards, {
  scope: "near",
});
crons.interval("publisher boards", { hours: 6 }, internal.publisher.rebuildBoards, {});

// Cover uploads nothing came to use are deleted a day after they were
// uploaded (coverUploads.ts sweep).
crons.interval("cover upload sweep", { hours: 1 }, internal.coverUploads.sweep, {});

// Pins the covers older Revisions name (coverUploads.pinRevisionCovers):
// starts it after a deploy and restarts it if it stalls. Until it is done,
// nothing deletes cover art; once it is, each tick reads one row.
crons.interval("cover pin backfill", { minutes: 10 }, internal.coverUploads.pinRevisionCovers, {});

export default crons;
