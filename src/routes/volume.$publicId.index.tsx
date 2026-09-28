import { createFileRoute, Link, notFound, redirect } from "@tanstack/react-router";

import { api } from "../../convex/_generated/api";
import { catalogQuery } from "~/lib/catalogData";
import { parsePublicId, volumePath } from "~/lib/slug";

/**
 * Slugless `/volume/{id}` (and any merged loser's ID): permanent redirect to
 * the canonical `/volume/{id}/{slug}` URL (spec §11). The slug is cosmetic;
 * the ID alone identifies the Volume.
 */
export const Route = createFileRoute("/volume/$publicId/")({
  loader: async ({ params }) => {
    const publicId = parsePublicId(params.publicId);
    if (publicId === null) throw notFound();
    const page = await catalogQuery(api.catalogPages.volumePage, { publicId });
    if (!page) throw notFound();
    throw redirect({
      href: volumePath(page.volume.publicId, page.volume.title),
      statusCode: 301,
    });
  },
  component: () => null,
  notFoundComponent: () => (
    <main>
      <h1>Volume not found</h1>
      <p className="notice">
        No volume lives at this address. <Link to="/">Browse the catalog</Link>.
      </p>
    </main>
  ),
});
