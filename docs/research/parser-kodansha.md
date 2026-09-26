# Kodansha parser audit

Checked 2026-09-26. No production writes or full catalog crawl.

The daily JSON feeds work in this environment. The HTML backlist cannot currently be certified: first-party series and volume requests encounter a Cloudflare challenge. Passing fixture tests establishes parser and pipeline behavior against captured pages, not current production reachability.

## Live evidence

Small unauthenticated, read-only requests produced these results. Responses were parsed using the repository's `convex/lib/kodansha.ts`, without calling import mutations.

| Source                                                                                                   | Observed result                                                                                                                                                |
| -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Release calendar](https://kodansha.us/wp-json/kodansha/v1/release-calendar)                             | Successful JSON, eight weekly buckets, 96 parsed items, 137 per-format snapshots.                                                                              |
| [New releases](https://kodansha.us/wp-json/kodansha/v1/new-releases)                                     | Successful JSON, six items, nine per-format snapshots.                                                                                                         |
| [Series listing, two-row sample](https://kodansha.us/wp-json/kodansha/v1/search-series?offset=0&count=2) | Successful JSON, both rows parsed, reported total 1,170. This is the publisher's total, not an independently verified crawl count.                             |
| [Blue Lock series](https://kodansha.us/series/blue-lock/)                                                | HTTP 403, Cloudflare challenge.                                                                                                                                |
| [Blue Lock volume 1](https://kodansha.us/series/blue-lock/volume-1/)                                     | Cloudflare challenge HTML, 5,480 bytes; volume parser returned null. No current ISBN/date/price extraction confirmed from live HTML.                           |
| [Robots rules](https://kodansha.us/robots.txt)                                                           | Default exclusions cover administration, login and search pages, not these API or series paths. This does not establish API stability or publisher permission. |

The web browsing tool could not retrieve the attempted endpoint/page; direct HTTP reads supplied the evidence above. No challenge bypass was attempted.

## How the adapter works

`convex/kodansha.ts` has a daily `sync` action and weekly `backlistSync`. Both use the `kodansha` observation identity and authority. The weekly registry row, `kodansha-backlist`, separately tracks crawl state and run health.

The daily feed merges calendar and new-release items by volume URL path and format. Physical and digital snapshots become distinct Releases. Weekly HTML processing enumerates comic series, extracts volume links from JSON-LD and anchors, then reads each Book's `workExample` ISBN, format, publication date and price. Those ISBNs allow linking to existing Releases from other sources. Novels and recognized non-manga titles remain out of the canonical catalog. Packaging without stated Volume Coverage stays unplaced for review. Both feeds store the volume's image (the calendar's `image`, the volume page's JSON-LD `image`) once per Edition: print and digital share one file, a changed image URL replaces it and deletes the old file once no format uses it, and backlist downloads count against the crawl's fetch budget. A placeholder image is recorded on the Release (keeping any art already shown), never stored, and not fetched again until its URL changes; a non-image body is an error retried next run.

Neither feed is a complete withdrawal sweep. Missing a rolling calendar entry or a skipped incremental page cannot establish a withdrawn publication.

## Repairs in this change

- Weekly rechecks previously updated the only crawl timestamp. For an ongoing Series, this could indefinitely postpone the promised 180-day full refresh and leave old Volume facts stale. Crawl observations now retain `fullCrawledAt` separately, preserving it through partial rechecks. Older observations use their last known crawl timestamp until a full crawl establishes the new field. Because the stamp is bookkeeping rather than a fact about the series, a full re-crawl that finds nothing else changed patches it in place and writes no snapshot-history row.
- API errors and malformed top-level payloads previously became empty arrays. The daily job could record a successful run while importing nothing. All three feed parsers now reject failed or missing data envelopes while permitting explicitly empty arrays.
- Dates previously admitted impossible days such as February 29 in a non-leap year and April 31. Date parsing now validates calendar days; the time part after a `T` or space separator is ignored whatever its zone shape, so a timezone-less or `+0000` timestamp still yields its day instead of an undated volume that is re-checked weekly forever.
- Backlist series/page/application failures previously ended with a successful run. Operational failures now make the final run fail, including failures carried across continuation actions. Review notices remain separate from operational failure counts. Daily application failures also fail the daily run; optional cover-download errors remain diagnostic notices.
- Reaching the listing page cap previously silently returned a partial catalog. It now fails before crawling from that incomplete listing. An empty page before the reported total is also an error.

## Validation

The focused suite passes 55 tests across `convex/lib/kodansha.test.ts` and `convex/kodansha.test.ts`. New regressions reproduce refresh starvation, failed API envelopes, impossible dates, failure propagation through scheduled continuations, and a listing that never terminates before the cap. Existing fixture tests cover ISBN matching, scope, packaging, human review and feed overlap. The existing fixture with three missing pages now correctly expects a failed run while retaining successfully imported records.

Changed TypeScript files were formatted with Prettier and passed Oxlint. Final Convex type checking passed with `tsc --noEmit -p convex/tsconfig.json`.

## Remaining data risks and next steps

1. Restore supported HTML access before enabling a large backlist sweep. Reproduce the same small series and volume requests from the deployed runtime, retaining status and response classification. If access remains challenged, ask the publisher for an approved feed or access route. Working JSON discovery alone does not supply ISBNs and per-format prices.
2. Source record identity for two physical bindings on one page depends on `workExample` order: the first takes the base physical key, later ones take ISBN suffixes. Reordering can move a different binding onto a stored source link. A fix needs a migration-aware identity policy, not only sorting the current response.
3. `withPageFacts` treats an existing ISBN as evidence that stored page facts outrank calendar facts. This protects format-specific dates, but prolonged HTML failure can freeze old dates even when the calendar changes. Record acquisition provenance and freshness so a date discrepancy becomes visible for review without silently replacing a more precise date.
4. The parser has no completeness assertion for a 200 response containing no volume links or no usable Book. An empty Series page can become remembered crawl state, while a null volume result is retried without failing the run. Add explicit response classification using real examples of legitimate empty pages, challenge pages, and schema changes.
5. A series is completed before the action budget is checked again. An unusually large Series can exceed the intended invocation budget. Use a volume-level continuation cursor if live catalog sizes or runtime measurements warrant it.
6. Creator names and cover URLs are parsed, but creator credits are not imported into canonical metadata. The series blurb is imported as the Series synopsis: the series page's JSON-LD `ComicSeries.description`, or else the search-series `short_description`. The backlist crawl carries it on each volume snapshot, and calendar snapshots keep it. Packaging-line pages ("3-in-1 omnibus edition") describe the line and are skipped. Volume-page `Book` JSON-LD has no `description`, so Kodansha supplies no per-volume Release Description.
