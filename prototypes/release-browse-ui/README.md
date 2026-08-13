# Release browse UI prototype

Throwaway prototype for three versions of MangaDB's public release browser, switchable with `?variant=` on the same route:

- `A` — Month grid
- `B` — Release agenda
- `C` — Release lanes

Run from the repository root:

```bash
npm run prototype:releases
```

Then open <http://localhost:4173/?variant=A>.

The data and interactions are fake and in-memory. This branch is a primary-source design artifact, not production code.
