# Parser and data-quality audit

Audited 2026-09-26 by seven parallel agents, covering ANN, Yen Press, Kodansha, Seven Seas, PRH, Open Library, and the shared import pipeline. This report describes the local working-tree changes. Nothing was deployed and no production catalog was modified.

## Assessment

The parsers have substantial tests and a useful common model for source observations, matching, human overrides, and review. They were not all working safely. This audit reproduced missing editions, ambiguous ISBN matching, stale review proposals, and incomplete imports being mistaken for complete sweeps. Tests now cover the fixes described below.

Passing fixtures does not establish production availability or catalog completeness. The live checks were small, read-only samples from this environment. No production run history, coverage totals, or configured source credentials were inspected.

## Source status

| Source       | Live evidence during this audit                                        | Main correction                                                                                        | Remaining limitation                                                                          |
| ------------ | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| ANN          | Report, XML API, and a release page accessible through direct requests | Reject incomplete enumeration/details before withdrawal; improve release identity and ISBN-10 handling | Representative pages do not prove full catalog coverage                                       |
| Yen Press    | Sitemap and sampled ISBN pages accessible                              | Visit separate ISBN pages when a shared slug does not expose both formats; admit JY manga              | Broad comics exclusions still omit some OEL manga                                             |
| Kodansha     | Calendar, new-release JSON, and catalog listing accessible             | Track full-crawl age independently of weekly rechecks; reject invalid feed shapes and dates            | Series/book HTML challenged here, preventing live backlist certification                      |
| Seven Seas   | WordPress API returned HTTP 403 with a Cloudflare challenge            | Validate pagination and book HTML; preserve observations through malformed listings                    | Current access from production remains unverified; adapter primarily models physical releases |
| PRH          | Unauthenticated endpoint returned HTTP 403, Developer Inactive         | Separate raw pagination size from accepted manga count; reject malformed/incomplete pages              | Needs activated API access and a verified configured imprint list                             |
| Open Library | A known manga ISBN returned a bibliographic JSON record                | Validate ISBN checksums and dates; exclude audio-only editions                                         | Live ISBN lookup does not validate the configured bulk-dump import                            |

Each source report below provides primary-source links, exact observations, and source-specific caveats.

## How the data reaches the website

Source HTTP responses are parsed into normalized snapshots. The import actions store source observations, then use matching to find a canonical Series, Volume, Edition, or Release. Authority rules decide whether an offered value fills a blank, updates a source-owned value, queues a conflict, or remains on the observation. Approved canonical records feed the public queries and pages.

That separation is worth preserving. A response that parses is not necessarily an in-scope manga, an unambiguous match, a complete sweep, or an approved canonical fact. The defects concentrated at those boundaries.

## Changes made

- Full-sweep safeguards now reject several malformed or incomplete source responses before they can withdraw unseen observations. PRH pagination continues past pages whose titles are all excluded by scope filters.
- Source-specific operational failures now produce failed runs, separately from ordinary requests for editorial review. See each source report for the implemented cases and residual limits.
- Yen Press plans work by slug and ISBN. It skips a second format request only when that ISBN was actually observed. JY is represented as a Yen Press imprint.
- Kodansha records the last full crawl separately, so frequent checks of recent releases cannot indefinitely postpone refreshing older volumes.
- ANN fallback release identities distinguish their manga and volume coverage. ISBN-10-only release metadata can supply a valid normalized ISBN-13.
- Open Library no longer manufactures a valid ISBN-13 from an invalid ISBN-10. Its shared ISBN conversion rejects non-Bookland EANs. Several adapters now reject impossible dates or retain only valid partial precision.
- Matching requires review when one ISBN resolves to multiple distinct active Releases. Multiple obsolete rows that merge into one Release still resolve to that survivor.
- Queued creation proposals reuse existing canonical Volumes rather than proposing duplicate same-label Volumes for another Edition.
- Reconciliation withdraws an importer-owned field correction when the current source snapshot no longer presents an actionable conflict. It leaves creation, cancellation, and human-owned proposals to their own review rules.

## Next priorities

1. Establish measured production coverage. For every run, record raw rows, accepted records, intentional exclusions by reason, malformed rows, failed requests, pages completed, and oldest successful refresh. Compare these with the previous comparable sweep. A green run with near-zero accepted records must be visible as a coverage anomaly.
2. Make sweeps resumable and explicit about scope. Persist the source scope, cursor, completion evidence, and heartbeat. Several adapters still risk exceeding action budgets or leaving a run marked running indefinitely after a crash. Withdrawal should require a completed sweep of the same scope.
3. Audit existing data before repairing it. The fixes prevent new mistakes; they do not clean previously duplicated Volumes, incorrect links, withdrawn observations, or already approved stale corrections. Produce a dry-run inventory with source evidence before applying repairs.
4. Connect collected metadata to canonical fields. Publisher descriptions now import through authority-aware reconciliation (see parser-pipeline.md). Creator strings can still remain in snapshots without reaching public pages. Define creator identities/roles before normalizing free text. Do not infer source completion status from the English release calendar.
5. Review scope decisions against a labeled sample. Include JY manga, OEL manga, manhwa, prose adaptations, novels, art books, omnibus editions, and bundles. Report false inclusions and false exclusions. A broad publisher or category label is not a reliable substitute for the project's manga definition.
6. Expand validation consistently. ISBN/date checks remain uneven between adapters. Add explicit rejection reasons before tightening identifiers globally, so rejected data is observable and is not mistaken for a disappeared record.
7. Maintain a small versioned live-fixture set per source and optional read-only smoke checks. Keep network checks separate from deterministic CI. Include physical/digital variants, partial dates, unnumbered extras, packaging, missing fields, and access-denied responses.

## Detailed reports

- [ANN](parser-ann.md)
- [Yen Press](parser-yen-press.md)
- [Kodansha](parser-kodansha.md)
- [Seven Seas](parser-seven-seas.md)
- [PRH](parser-prh.md)
- [Open Library](parser-open-library.md)
- [Shared pipeline](parser-pipeline.md)

## Validation

The combined suite passed all 708 tests across 52 files after the follow-up review fixes. The repository TypeScript check passed. Oxlint reported no warnings on changed TypeScript files, which were formatted with Prettier. `git diff --check` passed. No repository lint or formatter configuration existed, so those tools were run without adding dependencies or configuration to the project.

Unit and integration tests use local fixtures and Convex's test environment. They do not call a deployed database. Source reports record the separate live checks and their limitations.
