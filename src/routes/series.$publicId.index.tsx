import { createFileRoute, Link, notFound, redirect } from "@tanstack/react-router";

import { parsePublicId, seriesPath } from "~/lib/slug";
import { fetchSeriesPage } from "~/server/seriesPage";

/**
 * Slugless `/series/{id}` (and any merged loser's ID): permanent redirect to
 * the canonical `/series/{id}/{slug}` URL (spec §11). The slug is cosmetic;
 * the ID alone identifies the Series.
 */
export const Route = createFileRoute("/series/$publicId/")({
  loader: async ({ params }) => {
    const publicId = parsePublicId(params.publicId);
    if (publicId === null) throw notFound();
    const page = await fetchSeriesPage({ data: publicId });
    if (!page) throw notFound();
    throw redirect({
      href: seriesPath(page.series.publicId, page.series.title),
      statusCode: 301,
    });
  },
  component: () => null,
  notFoundComponent: () => (
    <main>
      <h1>Series not found</h1>
      <p className="notice">
        No series lives at this address. <Link to="/">Browse the catalog</Link>.
      </p>
    </main>
  ),
});
