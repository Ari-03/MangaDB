# Yen Press parser audit

Audited 2026-09-26. The parser reads the public sitemap, fetches title HTML, and records one observation per ISBN before shared catalog placement. It extracts title, format, binding, release date, USD price, imprint, series label, and category. Upcoming or recent books refresh weekly; backlist refreshes every 180 days. This was a local code audit with read-only public requests. No production import or stored-data audit ran.

## Live evidence

A direct fetch of the [sitemap](https://yenpress.com/sitemap.xml) returned 15,683 valid English-market ISBN URLs covering 9,383 distinct slugs. The current prose/audio/chapter slug filter leaves 11,076 URLs. These are discovery counts, not canonical Release counts or an estimate of total eligible manga.

Four complete live HTML responses parsed successfully:

| Page                                                                                                                                                   | Parsed result                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| [A Misanthrope Teaches a Class for Demi-Humans 4](https://yenpress.com/titles/9798855438611-a-misanthrope-teaches-a-class-for-demi-humans-vol-4-manga) | Two formats, Jan 26 2027, print ISBN 9798855438611 and digital 9798855438628 |
| [Nightschool 1 paperback](https://yenpress.com/titles/9780759528598-nightschool-vol-1)                                                                 | Only print ISBN 9780759528598, Apr 21 2009                                   |
| [Nightschool 1 digital](https://yenpress.com/titles/9780316213691-nightschool-vol-1)                                                                   | Only digital ISBN 9780316213691, Oct 31 2011                                 |
| [Little Witch Academia 1](https://yenpress.com/titles/9781975327453-little-witch-academia-vol-1-manga)                                                 | Category manga, imprint JY, two ISBNs, Jun 26 2018                           |

## Fixed

1. Same-slug URLs were assumed to expose identical formats. Nightschool disproves this: choosing one page lost the other ISBN indefinitely. Planning now retains each ISBN URL and suppresses a fetch only when that ISBN is fresh or was actually observed through another page. The continuation cursor includes ISBN, so a page budget cannot skip the second format.
2. The JY denylist rejected manga even when its page explicitly identified it as manga. JY manga now passes; JY books without manga category stay excluded. JY has its own canonical Publisher row under Yen Press. The [publisher describes JY as a mixed manga and graphic-novel imprint](https://yenpress.com/imprint/jy), and explicitly distinguishes [its new prose books from Little Witch Academia manga](https://yenpress.com/news/jy-for-kids-to-publish-four-prose-titles-fall-2023).
3. February 29 in a non-leap year and April 31 passed date parsing. Calendar round-trip validation now rejects impossible dates.
4. An empty or changed sitemap response silently ended a successful run. It now fails if no eligible title URLs can be parsed. A title page yielding no usable ISBN now records a page error.
5. Page failures previously left the Import Run successful. A separate failure flag now survives continuation and makes the final run fail. Review conflicts remain review outcomes, not fetch failures.

## Validation and limits

`convex/yenPress.test.ts` contains offline parser and Convex integration tests. Three newly saved fixtures are trimmed from the live Little Witch Academia and Nightschool pages. Tests cover both formats on separate same-slug pages with one-fetch and large budgets, existing shared-page deduplication, JY canonical placement, invalid dates, malformed sitemap responses, and failure propagation across continuations. Existing fixtures cover ordinary manga, deluxe packaging, a light novel, Ize Press, chapter exclusions, freshness, and disabled-source continuation.

The live checks prove those four pages still fit the parser. They do not establish full catalog coverage, verify every source field, or prove production scheduling and authentication work.

## Remaining data-quality work

- Non-Ize `comics` is still excluded wholesale. Nightschool is now fully fetched and observed but remains excluded from canonical placement. This classification conflicts with the project allowing original English-language manga: [Yen described Nightschool among its original manga publications](https://yenpress.com/news/hello-world-3). Build explicit, reviewable Series scope decisions rather than assuming every comic is manga or every non-Ize comic is Western-style.
- The parser depends on exact HTML class strings and positional alignment among tabs, prices, and detail blocks. Missing tabs still infer Paperback/Digital by position. Add format-alignment validation before treating template drift as trusted facts.
- Descriptions, cover images, contributor roles, page counts, and age ratings appear on the publisher pages but are not collected by this adapter. Release descriptions and covers would directly improve the website; extending normalized observations needs coordinated shared-schema work.
- Slug-based exclusions and English ISBN prefix checks are heuristics. They reduce fetch volume but should eventually be measured against a stratified sample, including OEL, JY, Ize, omnibuses, and retired titles.
- Existing JY observations already marked fresh may wait up to 180 days before the corrected scope logic is applied. A deliberate targeted reprocessing/import is needed to repair existing canonical omissions promptly. No production mutation was performed here.
- The sitemap has no reliable per-title freshness marker in this adapter, and imports are incremental. Absence must not be treated as withdrawal. Existing code correctly avoids doing so.
