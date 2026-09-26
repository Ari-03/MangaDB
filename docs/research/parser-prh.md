# PRH parser audit

Audited 2026-09-26. Scope is `convex/prh.ts`, `convex/lib/prh.ts`, their regression tests, and the handoff to `applyCatalogTitle`.

## Outcome

The adapter has useful offline coverage for ISBN matching, publisher aliases, packaging, authority conflicts, and creation boundaries. This audit found unsafe completion detection that could stop a catalog scan early and mark valid observations withdrawn. Those defects are fixed in this branch. A successful production import is not established by these tests.

## How it works

`sync` requires an enabled source and PRH API key plus imprint codes. It pages each imprint's titles in batches of 200. Daily runs sort newest first and retain today/future dates. Sunday or explicitly full runs walk the catalog. Each accepted ISBN becomes a normalized snapshot and an atomic `applyCatalogTitle` mutation. Full, uncapped sweeps without an imprint override may mark unseen observations withdrawn. The default cap is 50 pages per imprint.

`parseTitle` reads the title, ISBN, series number, on-sale date, format/binding, author, imprint, USD price and source URL. Shared title parsing identifies series and packaging. Scope checks exclude novels, prose imprints, audio, non-English records and some non-manga classifications. Manga appearance remains partly editorial judgment; BISAC or imprint membership cannot prove it.

## Fixed defects

1. An entire upstream page of excluded prose was indistinguishable from an empty upstream page. The action ended the imprint scan even when its total count said more titles existed. It now uses the raw page size for pagination. A regression puts 200 excluded titles before one valid manga and requires the second request and observation.
2. A malformed HTTP-200 JSON response, such as an error object without `data.titles`, became a valid empty full sweep. The parser now requires a numeric root `recordCount` and an `ok`/`warning` status, and tolerates a missing/null titles array only with an explicit `recordCount: 0`. A missing count is not evidence of an empty catalog. Action regressions first import a manga, inject malformed responses including `{data:{}}`, and verify the run fails while its observation remains active. The envelope was verified live on 2026-09-26 with the production key (see below); a redacted page is pinned as `convex/lib/__fixtures__/prh/titles-page.json`.
3. An empty upstream page before the reported total now fails the run rather than claiming a complete sweep.
4. A per-record mutation exception now forfeits withdrawal eligibility. The run is now marked failed after any record write exception, while ordinary review notices remain successful runs. Processing continues for other titles, and regression coverage checks this distinction. It does not claim absence for records whose writes failed.

## Current primary-source findings

PRH's [official API documentation](https://developer.penguinrandomhouse.com/docs/read/enhanced_prh_api/concepts/POST_requests) distinguishes database filters from search facets. Database filters include `imprintCode` and `onSaleFrom`; the examples use the latter spelling with a capital S. Pagination and sort parameters remain in the URL, and the API key is a URL parameter. The current adapter comments cite historical probes with `imprint` and `onsaleFrom`. Those probes do not establish that the documented filters fail. The scoped endpoint remains a reasonable existing strategy, but a future optimization should test the documented spelling and inspect returned filter parameters before changing pagination.

PRH's [comics retailer FAQ](https://prhcomics.com/faq/) names Kodansha, Seven Seas and Dark Horse among its distribution clients. [Seven Seas](https://sevenseasentertainment.com/about/) specifically describes PRH distribution for print books. This does not establish complete digital coverage. The [official publishers and imprints list](https://www.penguinrandomhouseretail.com/wp-content/uploads/2024/04/Penguin-Random-House-Publishers-and-Imprints_3.5.26.pdf) also lists Square Enix. Publisher distribution coverage and this deployment's configured imprint coverage are different questions.

## Validation and limits

- Unauthenticated, the titles endpoint returns HTTP 403 `Developer Inactive`. With the production key (read from the production deployment's env on 2026-09-26, read-only probes only) it answers: every page carries `status` (`ok`, or `warning` with the data intact when an unknown query param is sent), a root `recordCount`, and `data.titles`; a `start` past the end and an unknown imprint code both return HTTP 404 `Not found`, never an empty 200 page. The 14 configured imprint codes are all in PRH's imprint list (737 codes), and 40 sampled imprints each report at least one title, so a zero-record envelope was not observable. Note: the `_links` hrefs in every response embed the API key; the pinned fixture has it redacted.
- Official API documentation was fetched successfully. The interactive I/O documentation exceeded the browser tool's response-size limit.
- Offline tests use `convex-test` with stubbed API responses. They validate parser and database behavior without touching production.
- No production credentials, scheduler state, recent runs, configured imprint list, or complete live title pages were inspected. Production freshness and completeness remain unverified.

## Remaining work by impact

- Record raw seen, accepted, excluded, malformed and failed counts separately. Today `recordsSeen` counts only accepted snapshots, so scope drift and catalog shrinkage are difficult to diagnose.
- Compare configured imprints against the official imprint endpoint with an activated key. Check all intended parent publishers and child imprints, including separate manhwa lines; no parser can recover an imprint that is never requested.
- Full sweeps make one mutation per accepted title inside one action. Large combined imprint sets may exceed the action execution budget. Resume work in durable batches and only withdraw after the entire declared sweep succeeds.
- Malformed individual title rows still disappear through `parseTitle`'s null result, together with intentional scope exclusions. Add rejection reasons before treating such runs as evidence for withdrawal.
- ISBN validation checks length/characters but not checksum. `parseOnsale` accepts impossible calendar dates such as February 31. These should use shared validated primitives across sources.
- Daily future-only refreshes do not discover a release date changed into the past until a full sweep. Scope and imprint configuration changes can also invalidate historical withdrawal assumptions. Persist sweep scope before using absence as evidence.
- Review PRH's broad TOKYOPOP `Graphic Novel` exclusion against a sampled live catalog periodically. It is a heuristic documented from prior observations, not a permanent provider guarantee.
