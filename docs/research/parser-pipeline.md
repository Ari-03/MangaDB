# Shared parser pipeline audit

Audit date: 2026-09-26. Scope: local ingestion, matching, reconciliation, review creation, observations, run scheduling, and source health. This audit used repository source and local tests. It did not query production, measure production completeness, or run imports against production. Individual source reports cover live publisher endpoints.

## How records reach the website

Adapters normalize source responses into snapshots. Observations retain source identity and append superseded snapshots. Matching first uses persisted source links, then ISBN, then publisher/title/volume/format. Creation builds Series, Volumes, Editions and Releases. Reconciliation uses source authority and revision provenance to update facts, queue disagreements, or record weaker claims. Human field overrides remain protected. The registry controls cadence and field authority, while the shared hourly dispatcher schedules adapters.

The separation is useful: adapters can change without changing the catalog model. Snapshot history and source-authored revisions already provide evidence for diagnosing wrong records. The missing protections described below concern what happens between successful parsing and approved catalog data.

Primary references: [domain definitions](../../CONTEXT.md), [matching](../../convex/lib/matching.ts), [pipeline](../../convex/lib/pipeline.ts), [reconciliation](../../convex/lib/reconcile.ts), [observations](../../convex/lib/observations.ts), [source registry](../../convex/importSources.ts), and [scheduler](../../convex/imports.ts). No ADR files were found during this audit.

## Repairs included in this work

### Duplicate ISBNs no longer select an arbitrary Release

Previously, `matchRelease` resolved ISBN rows through merges and selected the first active row. Two distinct active Releases with the same ISBN therefore silently linked an incoming observation to whichever row appeared first. The title check could not protect against duplicates within the same Series, and insertion order could decide whether a mixed-title collision matched or reviewed.

The ISBN rung now deduplicates resolved survivors and reviews multiple distinct active Releases. Several merged rows pointing to the same surviving Release still match. Regression tests exercise both cases in [matching.test.ts](../../convex/lib/matching.test.ts).

### Review proposals reuse existing Volumes

Previously, `queueCreationProposal` created a Volume operation for every parsed label even when the Series already contained those Volumes. Approval executed unconditional inserts in `applyCreatePlan`. An omnibus covering existing Volumes 1 and 2 plus new Volume 3 would duplicate 1 and 2, fragmenting reading history, ownership coverage, and counts.

The proposal builder now references existing active Volumes, follows same-Series merge survivors, and creates only missing labels. Equivalent repeated labels such as `3` and `03` produce one Volume and one coverage row. Tests pass the generated proposal through the real creation planner and application functions and assert the resulting catalog and coverage. An additional test checks a merged unnumbered Volume.

This fixes the state known when a proposal is queued. Approval's stale check now also covers the records a create op references by ID (reused Volumes, the series, the publisher): one merged or hidden before review returns the graceful stale result instead of throwing from the creation planner. If another import creates a missing Volume before approval, approval still needs an explicit stale-creation identity check. Existing manual proposals and old queued proposals are not retroactively rewritten.

## Remaining issues, ranked by data impact

### Returning listings leave cancellation proposals open

`markWithdrawn` can queue a `hide` operation for a future Release. Both branches of `upsertObservation` clear `withdrawn` when that listing returns, but do not withdraw the cancellation proposal. A moderator can still approve the old cancellation even when the latest snapshot shows the book is available again.

Fix: identify importer-owned cancellation proposals separately from field conflicts and withdraw the corresponding open cancellation when a listing returns. Test disappearance, queued cancellation, identical reappearance, and attempted approval of the old proposal. Do not cancel unrelated human proposals.

Evidence: [withdrawal review creation](../../convex/imports.ts), `queueWithdrawalReview`; [observation reappearance](../../convex/lib/observations.ts), `upsertObservation`.

### A stranded running import stops future scheduled imports indefinitely

`runScheduled` skips a source whenever its latest run is `running`, regardless of age. There is no shared heartbeat, lease expiry, or recovery pass. A crashed or abandoned action chain therefore leaves the source looking healthy but permanently unscheduled. Source-health transitions only happen when `finishRun` records an outcome.

Fix: track progress and a renewable lease for action chains, then expire stale runs through a watchdog. Do not use a short fixed duration because a healthy full crawl can run for hours. Test crash after `startRun`, healthy long-running progress, timeout recovery, and late completion from an expired run.

Evidence: [run scheduling](../../convex/imports.ts), `runScheduled`, `startRun`, and `finishRun`; [chain continuation](../../convex/lib/importRuns.ts).

### Approval can still create duplicate or incomplete structures

Creation proposals validate referenced rows but do not recheck the semantic identity of newly created Volumes at approval time. Two proposals queued before either is approved can both create the same Series/label. Packaged proposals carry a line position but no Edition Line membership, and the proposal creation registry cannot create Edition Lines. A human review currently has to resolve more structural work than the proposed operations express.

Fix: define approval-time duplicate checks and require explicit Edition Line membership for packaged releases. Return a stale proposal error or refresh the proposal for review when identity assumptions change. Avoid silently merging human-authored create operations.

Evidence: [proposal creation](../../convex/lib/proposalCreates.ts), `CREATABLE_TABLES`, `planCreateOps`, `applyCreatePlan`; [queued operations](../../convex/lib/pipeline.ts), `queueCreationProposal`.

### Field availability is narrower than the registry suggests

Registry rows advertise creator authority, but the shared creation payload contains publication fields only. Publisher descriptions are intentionally observation-only in the Seven Seas parser. `sourceStatus`, although defined as an imported fact in the domain model, is not an authority category in `FIELD_CATEGORY`. The website cannot gain those fields merely because the parser fetched them.

There is no canonical creator field or creator table in the current schema, so public queries have no creator credits to return. Release descriptions do have a schema field and are returned by `catalogPages.ts`; shared creation and reconciliation do not import the publisher copy. Series pages already render canonical `sourceStatus` and `synopsis` when present, but improved parser extraction alone cannot populate them through the current shared payloads. These gaps explain why richer source snapshots can coexist with sparse public pages.

Treat these as product/schema decisions, not parser failures. Agree which creator roles, source completion status, and release descriptions should become canonical. Then add explicit normalized fields, validation, provenance, authority, and UI consumption together.

Evidence: [authority categories](../../convex/lib/authority.ts), [ReleasePayload](../../convex/lib/pipeline.ts), [Seven Seas snapshot policy](../../convex/lib/sevenSeas.ts), [domain definitions](../../CONTEXT.md).

### Bulk withdrawal and revision reads have no paging boundary

`markWithdrawn` collects every stale observation and processes suppression queries and proposal creation in one mutation. `reconcileFields` reads all revision history for every incoming record. These operations grow with catalog size and record age. They are scalability risks established by code inspection, not observed production limit failures.

Fix: page withdrawal work with a completed-sweep identifier, and maintain or query field provenance without rereading unbounded history. Test multiple pages, retries, and atomic proposal deduplication.

## Measurement needed before claiming a source is healthy

Run success only establishes that the importer completed its current code path. Add per-source counts for discovered records, fetched details, parsed records, deliberate exclusions, parse failures, linked observations, canonical creations, queued reviews, and unplaced records. Record whether a sweep was complete and the source scope it covered. Track missing ISBN/date/cover rates on accepted releases and compare consecutive complete sweeps for unexpected count drops.

Audit a stratified sample for ordinary volumes, digital/physical pairs, omnibuses, box sets, one-shots, renamed works, and newly announced releases. Report canonical coverage separately from observations and queued proposals. A record retained only as an observation does not improve the public catalog yet.

## Validation

The new duplicate-Volume test failed before the repair: four Volume create operations were queued where one was needed. All 41 matching and pipeline tests passed after the repairs. TypeScript checking passed. Changed TypeScript files were formatted with Prettier. No repository linter configuration or lint script was present.

A broader initial run passed 84 tests and failed the existing withdrawal test in `convex/reconcile.test.ts` while another audit agent was changing Seven Seas complete-sweep handling. That result was sent to the integrating agent for resolution. It was not a matching regression. The integrating agent's final combined test run is the authoritative overall result.
