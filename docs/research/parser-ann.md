# ANN parser audit

Audit date: 2026-09-26. Scope: `convex/ann.ts`, `convex/lib/ann.ts`, and their tests. This audit used read-only public requests and local Convex tests. It did not inspect production records or run an import against production.

## How the import works

The mirror enumerates manga through report 155, fetches details in batches of 50, then builds Series and Volume observations from English GN and eBook release lines. Existing Releases link by ISBN, with a restricted volume-and-format fallback. A separate pass fetches unlinked release pages for publisher and ISBN information, then creates eligible leaf Releases under existing Volumes. Publisher feeds retain higher authority.

The endpoint choice and batch size match [ANN's API documentation](https://www.animenewsnetwork.com/encyclopedia/api.php). ANN documents a limit of one request per second per IP, a maximum batch size of 50 titles, and source attribution with a link to the relevant Encyclopedia entry. The adapter waits 1.1 seconds before requests and stores those entry URLs. That delay is local to each action; it does not coordinate unrelated processes sharing an IP.

## Live checks

All four direct HTTPS requests returned HTTP 200. The web research tool failed to open ANN, so these checks used bounded curl requests, followed by the actual TypeScript parsers.

| First-party source                                                                                           | Result on this audit                                                                                                           |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| [API documentation](https://www.animenewsnetwork.com/encyclopedia/api.php)                                   | Documents the endpoints, pagination, batches, attribution, and rate limit described above.                                     |
| [Report 155, two manga](https://www.animenewsnetwork.com/encyclopedia/reports.xml?id=155&type=manga&nlist=2) | Parsed two rows, IDs 40576 and 40575, with decoded titles.                                                                     |
| [Frieren API record](https://cdn.animenewsnetwork.com/encyclopedia/api.xml?manga=24449)                      | Parsed one Series and 18 accepted release lines; 17 had a valid ISBN. This is one sample, not a catalog completeness estimate. |
| [Frieren eBook 1 release](https://www.animenewsnetwork.com/encyclopedia/releases.php?id=42006)               | Parsed VIZ Media, eBook 1, ISBN 9781974729548, 2021-11-09, USD 6.99, and manga ID 24449.                                       |

These checks establish that the sampled current endpoints and layouts work. They do not establish full-catalog coverage, production cadence, or agreement with every publisher.

## Reproduced and fixed

1. **Incomplete mirrors withdrew observations.** HTML returned with HTTP 200 looked like an empty report. Missing manga details and malformed report rows also passed silently. Explicit batch failures were collected, but the action still withdrew everything it had not seen and finished successfully. New validation checks the report envelope, item counts, required item fields, detail envelope, and requested detail IDs. Any batch or apply exception prevents withdrawal and the follow-on page pass, and finishes the run as failed. Four action regressions reproduced the old behavior before the fix.
2. **Page fetch failures looked healthy.** Forbidden responses and unrecognized HTML were stored on observations but omitted from Import Run errors. Both now fail the page pass after preserving the per-page diagnostic state. Ordinary placement holds, review proposals, and absent pages returning 404 do not count as transport or parsing failures. Two regressions reproduced successful runs with zero errors before this fix.
3. **Fallback release IDs collided.** Lines without ANN release links used only format, volume label, and date. Two different manga and two omnibus ranges could all overwrite the same observation. The fallback now includes the manga ID and complete release text, with ISBN or date as a further discriminator. A four-line regression previously produced one identity and now produces four. Numeric ANN release IDs remain unchanged. Previously stored fallback observations may be withdrawn and replaced on the next complete mirror; this change does not repair historical canonical links created by a collision.
4. **ISBN-10-only pages lost both identifiers.** The page parser discarded a valid ISBN-10 unless the page also supplied ISBN-13. It now derives ISBN-13 from valid ISBN-10. The existing checksum validator still controls acceptance, and conflicting ISBN-10/13 pairs do not retain the inconsistent ISBN-10.

## Remaining work

- Add a small, scheduled read-only canary for report, detail, and release-page parsing. Report counts and required-field coverage separately from successful HTTP requests. Refresh representative fixtures when it detects a change.
- Revisit page freshness. Successful release pages are cached indefinitely and linked lines leave the page candidate query. API release dates refresh, but publisher, ISBN, and price corrections on those pages can remain unseen. Unparsed pages also currently wait 90 days before retrying. A failed pass followed by a no-fetch pass can report success without recovering the original page.
- Validate that a fetched page's manga ID matches the observation before placement. The parser extracts that ID, but placement currently does not use it as a consistency check.
- Reject impossible calendar days such as February 31. Current date parsing only bounds days to 1 through 31. The blanket pre-2010 day-one precision downgrade is an existing heuristic, not a rule documented by the ANN API page reviewed here.
- Review fallback matching around Editions. The release-page sibling search can consider an Edition that covers additional Volumes; it should not attach a single-volume line to an ISBN-less omnibus merely because they share a Volume and format.
- Audit attribution in the public UI. Storing citation URLs establishes available provenance but does not prove that each rendered page meets ANN's attribution requirement.
- Measure production coverage before expanding ingestion. Useful denominators include raw report rows, returned detail IDs, accepted versus rejected release lines, valid ISBNs, publisher resolution, and unplaced observations grouped by reason. No production data was available to this audit, so no production completeness percentage is claimed.

## Validation

- `npm exec --yes --package=bun -- bun run test -- convex/ann.test.ts convex/lib/ann.test.ts`: 41 tests passed after the fixes.
- `npm exec --yes --package=bun -- bun run typecheck`: passed.
- Prettier formatted the changed ANN files and this report; `git diff --check` passed.
