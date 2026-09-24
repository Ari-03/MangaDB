# Site redesign mock-ups

Five throwaway static prototypes of the public MangaDB site, each a directory of
hand-written HTML + one `styles.css` (no build step). They share `BRIEF.md`
(requirements, reference, constraints) and `sample-releases.json` (171 real
September 2026 releases scraped from the live site, 30 with real cover art).

```sh
npm run prototype:redesign   # then open http://localhost:4174/
```

`index.html` is the gallery. Data and interactions are fake; the winning
direction gets ported into `src/styles.css` and the React routes.
