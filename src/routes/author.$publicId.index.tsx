import { createFileRoute, Link, notFound, redirect } from "@tanstack/react-router";

import { api } from "../../convex/_generated/api";
import { catalogQuery } from "~/lib/catalogData";
import { authorPath, parsePublicId } from "~/lib/slug";

/**
 * Slugless `/author/{id}`: permanent redirect to the canonical
 * `/author/{id}/{slug}` URL, as for a Series. The ID alone identifies the
 * author.
 */
export const Route = createFileRoute("/author/$publicId/")({
  loader: async ({ params }) => {
    const publicId = parsePublicId(params.publicId);
    if (publicId === null) throw notFound();
    const page = await catalogQuery(api.people.authorPage, { publicId });
    if (!page) throw notFound();
    throw redirect({
      href: authorPath(page.author.publicId, page.author.name),
      statusCode: 301,
    });
  },
  component: () => null,
  notFoundComponent: () => (
    <main>
      <h1>Author not found</h1>
      <p className="notice">
        No author lives at this address. <Link to="/authors">Browse authors</Link>.
      </p>
    </main>
  ),
});
