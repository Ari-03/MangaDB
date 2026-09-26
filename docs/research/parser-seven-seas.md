# Seven Seas parser audit

Checked 2026-09-26. Scope: `convex/sevenSeas.ts`, `convex/lib/sevenSeas.ts`, their tests, and the domain definitions in `CONTEXT.md`.

## What works, and what remains unverified

The adapter has a complete offline import path. It discovers WordPress book records, checks `modified_gmt`, fetches detail HTML, stores Source Observations, and passes facts through matching and reconciliation. Its tests cover creation, update history, Human Overrides, review gates, ISBN matches, covers, and withdrawal. A re-read book whose cover URL changed gets the new image and the old stored file is deleted; an SVG or tiny placeholder is recorded on the Release (keeping any art already shown), never stored, and not fetched again until its URL changes; a non-image body is an error retried next run.

Live operation could not be established from this environment. A read-only GET to [the first-party book endpoint](https://sevenseasentertainment.com/wp-json/wp/v2/books?per_page=3&orderby=modified&order=desc) returned HTTP 403 with `cf-mitigated: challenge`. The web tool also returned HTTP 403 for [Gilded Seven Vol. 1](https://sevenseasentertainment.com/books/gilded-seven-vol-1/) and [the digital catalog](https://sevenseasentertainment.com/digital/). No challenge bypass was attempted. This demonstrates an access blocker from this environment, not an outage for all visitors or proof that production Convex requests fail.

Search-indexed first-party pages still show the expected release metadata. [Gilded Seven Vol. 1](https://sevenseasentertainment.com/books/gilded-seven-vol-1/) has a Manga format and ISBN; [The Secret Garden](https://sevenseasentertainment.com/books/the-secret-garden/) has a Novel format. Those observations support the distinction between manga and prose, but search results do not validate the current raw HTML selectors. Existing parser fixtures state they were captured on 2026-08-19.

## Fixed in this audit

- Missing pagination headers previously caused the adapter to treat page one as the entire catalog and withdraw unseen observations. It now fails the run before withdrawal when pagination metadata is missing or invalid, the collection is malformed, or a declared page is unexpectedly empty. This follows [WordPress's documented pagination contract](https://developer.wordpress.org/rest-api/using-the-rest-api/pagination/), which exposes `X-WP-TotalPages` on paginated responses. An empty first page (zero declared pages) also fails the run, since a 6,000-book catalog never legitimately empties and a complete-sweep claim would withdraw everything.
- Malformed listing records previously disappeared silently. They are still skipped, but each one is logged, fails the run, and prevents a complete-sweep claim. Numeric IDs must also be positive safe integers.
- An HTTP 200 challenge or error document previously produced a plausible book snapshot with a guessed Series and paperback binding. Detail parsing now requires the expected `volume-meta` block. Partial metadata inside a recognized block remains supported.
- Detail-fetch and parse failures previously finished the Import Run as successful. They now finish it as failed so source-health tracking can detect recurring failures. A removed book page (HTTP 404) is logged as a notice only, since it is retried while listed and would otherwise fail every run. Review decisions remain distinct from transport or parse failure.
- Title-based scope filtering previously ran before presence bookkeeping. A listed book renamed to include a prose discriminator could be falsely withdrawn. Presence is now recorded before scope filtering.
- US date parsing accepted impossible dates such as February 29 in a non-leap year. It now validates the calendar date.

## Remaining data-quality gaps

1. Restore an approved, reliable collection route before describing the source as operational. Verify a small request from the actual import runtime. If it is also challenged, obtain publisher access or a supported feed. The indexed [release calendar](https://sevenseasentertainment.com/release-dates/) and [release archive](https://sevenseasentertainment.com/release-dates/archive/) offer potential alternative discovery pages; neither was established as an accessible substitute in this audit.
2. Every normalized book still becomes a physical Release. The model does not distinguish ebook records or source imprints, and defaults to paperback when hardcover is not explicitly stated. These assumptions need representative first-party samples before expansion. A format field on the snapshot and imprint mapping should precede importing digital records.
3. Metadata selectors remain regular expressions against a historical page shape. They do not comprehensively isolate metadata from recommendations or navigation. Obtain fresh permitted fixtures for ordinary manga, hardcover, omnibus, box set, out-of-print books, and digital releases before broadening selectors.
4. ISBN extraction checks length, not checksum. This can feed invalid identifiers into matching. ISBN validation should be shared across adapters rather than added only here.
5. An unchanged `modified_gmt` skips detail fetches even after a cover download failed. Cover retries need their own pending state or bounded retry path. `force` can currently revisit such records, but is not an automatic recovery strategy.
6. `modified_gmt` is assumed to reflect every relevant publisher field change. That assumption was not verified against current WordPress custom-field updates. A periodic detail refresh would bound staleness.
7. Page-number pagination ordered by modification time can move records between pages during a sweep. Valid pagination headers do not prove snapshot consistency. Stable ordering, repeated-boundary checks, or a second absence check should precede stronger withdrawal guarantees.
8. Creators are collected as observations but do not populate canonical website fields. The listing blurb (`content.rendered`) is now the Release Description at authoritative rank. It is set at creation and reconciled on linked Releases.
9. The publisher's [book archive](https://sevenseasentertainment.com/series/seven-seas-book-archive/) explicitly groups permanently out-of-print releases. A generic archive Series link must not become a real Series identity. Current normalization trusts a detail page's Series link; verify whether archived detail pages point to that archive before importing them.

## Validation

Both Seven Seas test files pass, 33 tests total. Added regressions exercise malformed and incomplete listings, HTTP 200 error pages, false withdrawal after a scope change, and calendar dates. Changed TypeScript files were formatted with Prettier. Repository lint/type validation is coordinated by the main audit agent.

No production mutations, imports, or deployments were performed. Offline test success establishes behavior against fixtures; live data extraction remains blocked and unverified.
