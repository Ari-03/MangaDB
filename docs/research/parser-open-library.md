# Open Library parser audit

Audited 2026-09-25. Read `CONTEXT.md`, the dump filter, `convex/lib/openLibrary.ts`, `convex/openLibrary.ts`, their tests, and the import configuration documentation.

Open Library can fill useful gaps, but this audit does not establish that the production import is configured or healthy. A live edition request worked. Offline tests verify parsing and catalog mutations; they do not measure coverage of the full dump.

## How it works

The offline `scripts/filter-openlibrary-dump.mjs` keeps publisher-related editions from the monthly dump. An operator hosts that file and configures `OPENLIBRARY_DUMP_URL`. The adapter streams records, normalizes ISBNs, titles, language, binding and dates, then matches existing Releases. It can create a Release only under existing Series, Volume and Publisher structure. It does not withdraw records missing from the filtered slice.

This use of a bulk dump fits Open Library's guidance. Its [dump documentation](https://openlibrary.org/developers/dumps) describes monthly exports with five tab-separated columns ending in the full JSON record. The [API documentation](https://openlibrary.org/developers/api) asks bulk users to use dumps. A Work is not a MangaDB Series identity: the [Books API documentation](https://openlibrary.org/dev/docs/api/books) distinguishes umbrella Work metadata from edition-specific publisher and ISBN facts.

## Verified and repaired

- An invalid ISBN-10 such as `1974709931` previously generated the valid ISBN-13 `9781974709939`. This could link the wrong source record to a real Release. Both checksum and permitted formatting are now checked before conversion. Malformed prefixed values such as `SKU1974709930` no longer turn into valid identifiers by deleting arbitrary characters.
- A checksum-valid EAN such as `4006381333931` previously passed the shared ISBN helper. The helper now requires a 978 or 979 prefix. This also affects ANN and publisher adapters using that helper. The [International ISBN Agency](https://www.isbn-international.org/index.php/node/10) identifies those two prefixes and explains the check digit. This is structural validation, not confirmation that an identifier has been assigned.
- Impossible dates such as `2026-02-31` previously survived as exact publication dates. Invalid days now retain the valid month precision. Tests cover leap years and century exceptions.
- Audio identified only through `physical_format` previously became a physical manga Release. Audio CD, audiobook, cassette and MP3 formats are now excluded even when the title lacks an audio marker.
- Invalid line limits are rejected before starting a run. Zero previously could schedule continuations without progress. The accepted range is now 1 to 20,000 whole lines.
- Malformed dump envelopes, invalid edition JSON and mismatched edition identities previously disappeared silently. They now produce line-specific import errors. The action continues processing valid records but finishes as failed when any processing error occurred, allowing source health tracking to see the failure.

## Live evidence

A read-only GET of [ISBN 9781974709939](https://openlibrary.org/isbn/9781974709939.json) returned HTTP 200. The response named `/books/OL30165195M`, `Chainsaw Man, Vol. 1`, publisher `Viz Media`, English language, paperback binding, ISBN-10 `1974709930`, and publication date `2020`. Running that response through the local parser produced Series title `Chainsaw Man`, Volume label `1`, both matching ISBNs, physical/paperback, and a year-only date. This confirms one real edition shape and deliberately preserves the source's limited date precision.

No live database import, production mutation, full dump download or deployment was performed.

## Remaining gaps

1. Import execution has a default limit of 20,000 sequential mutation calls per action and no elapsed-time checkpoint. A continuation fetches the file again and reads past all prior lines. Large filtered files need measured execution times and either smaller immutable chunks or resumable byte offsets. Configure immutable versioned dump URLs so continuations cannot read a changed file.
2. An empty file or a valid file containing only out-of-scope records can still finish successfully with zero records. Malformed syntax now fails, but distinguishing an intentionally empty slice from an upstream filtering failure needs a dump manifest with counts, generation time and checksum.
3. ISBN registration groups are used as hard language gates, even against an explicit English declaration. The [ISBN Agency](https://www.isbn-international.org/index.php/node/10) describes groups as countries, geographical regions or language areas. Registration location is not proof of the text's language. The current heuristic can both omit English imports and admit undeclared non-English editions. Changing this needs a reviewed scope policy and representative fixtures.
4. Missing or unknown `physical_format` defaults to physical. Digitized library availability should not itself imply a commercial digital Release, but absent binding metadata also cannot prove a physical format. Keep this uncertainty visible in observations and measure it before allowing broad leaf creation.
5. The one-Release-per-Volume/publisher/format rule suppresses legitimate alternate bindings with different ISBNs. That conservative rule protects against duplicates, but differs from the domain model where binding can define another Release. Record these held observations in a data-quality report before relaxing matching.
6. The operator's publisher allowlist can miss editions using unfamiliar imprints. Arrays containing multiple distinct ISBNs collapse to one selected pair. Measure omitted publishers and multi-ISBN records from the filtered dump to estimate recall loss.

## Local validation

Run `npm exec --yes --package=bun -- bun run test -- convex/lib/openLibrary.test.ts convex/openLibrary.test.ts` to exercise parser checks and mocked end-to-end imports. Network responses are stubbed in action tests, so they can verify reconciliation and failure accounting without production access. Changed TypeScript files were formatted with Prettier; aggregate type checking and linting belong to the parent audit.
