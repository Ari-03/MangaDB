# Series and volume pages prototype

> **THROWAWAY PROTOTYPE** — decision material for “Prototype: series and volume pages across editions,” not production code.

Three page-hierarchy variants, switchable via `?variant=`, on the standalone `/prototype/series-volume-pages/` route.

Run from the repository root:

    python3 -m http.server 4173

Then open <http://localhost:4173/prototype/series-volume-pages/>.

## What to compare

- `?variant=A` — **Reading Path**: canonical Series and Volume order is primary; publisher packaging is inspected from a selected Volume.
- `?variant=B` — **Edition Shelves**: Edition Lines are primary; every shelf keeps its Volume Coverage visible.
- `?variant=C` — **Catalog Map**: Series, Volumes, Releases, Release Variants, and Release Bundles are visible together.

Each variant switches between a deliberately simple five-Volume Series and fake Tokyo Ghoul decision-testing data. The latter includes the Tokyo Ghoul / Tokyo Ghoul:re Series Family, an omnibus labeled “1” covering Volumes 1–3, a split Volume, and a box set containing an exclusive cover Release Variant. All publication facts beyond the Series names are intentionally fake.

## Decision prompt

Pick the hierarchy that makes these statements easiest to understand together:

1. “Tokyo Ghoul Volume 2 is the second canonical content unit.”
2. “Monster Edition 1 is a publisher package covering canonical Volumes 1–3.”

Then note which terminology, cover treatment, and cross-links should survive from the other variants.
