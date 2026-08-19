import { createFileRoute, Link, notFound, redirect } from "@tanstack/react-router";

import { editionPath, parsePublicId } from "~/lib/slug";
import { fetchEditionPage } from "~/server/catalogPages";

/**
 * Slugless `/edition/{id}` (and any merged loser's ID): permanent redirect
 * to the canonical `/edition/{id}/{slug}` URL (spec §11). The slug is
 * cosmetic; the ID alone identifies the Edition.
 */
export const Route = createFileRoute("/edition/$publicId/")({
  loader: async ({ params }) => {
    const publicId = parsePublicId(params.publicId);
    if (publicId === null) throw notFound();
    const page = await fetchEditionPage({ data: publicId });
    if (!page) throw notFound();
    throw redirect({
      href: editionPath(page.edition.publicId, page.edition.title),
      statusCode: 301,
    });
  },
  component: () => null,
  notFoundComponent: () => (
    <main>
      <h1>Edition not found</h1>
      <p className="notice">
        No edition lives at this address. <Link to="/">Browse the catalog</Link>.
      </p>
    </main>
  ),
});
