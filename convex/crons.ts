// Scheduled jobs (spec §6): one hourly tick reads the Approved Source
// registry and starts every enabled source that is due per its cadence —
// so cadence stays data (registry rows), not cron code. Adapters are
// dispatched by imports.runScheduled.

import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval("import cadence tick", { hours: 1 }, internal.imports.runScheduled, {});

export default crons;
