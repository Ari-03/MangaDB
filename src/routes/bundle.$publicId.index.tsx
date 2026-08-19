import { createFileRoute, Link, notFound, redirect } from "@tanstack/react-router";

import { bundlePath, parsePublicId } from "~/lib/slug";
import { fetchBundlePage } from "~/server/catalogPages";

/**
 * Slugless `/bundle/{id}` (and any merged loser's ID): permanent redirect to
 * the canonical `/bundle/{id}/{slug}` URL (spec §11). The slug is cosmetic;
 * the ID alone identifies the Bundle.
 */
export const Route = createFileRoute("/bundle/$publicId/")({
  loader: async ({ params }) => {
    const publicId = parsePublicId(params.publicId);
    if (publicId === null) throw notFound();
    const page = await fetchBundlePage({ data: publicId });
    if (!page) throw notFound();
    throw redirect({
      href: bundlePath(page.bundle.publicId, page.bundle.name),
      statusCode: 301,
    });
  },
  component: () => null,
  notFoundComponent: () => (
    <main>
      <h1>Bundle not found</h1>
      <p className="notice">
        No bundle lives at this address. <Link to="/">Browse the catalog</Link>.
      </p>
    </main>
  ),
});
