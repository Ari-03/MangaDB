import { createFileRoute, Link, notFound, redirect } from "@tanstack/react-router";

import { normalizeIsbn } from "~/lib/isbn";
import { bundlePath, editionPath } from "~/lib/slug";
import { fetchIsbnTarget } from "~/server/catalogPages";

/**
 * `/isbn/{isbn}` (ticket #23, spec §11): the ISBN entry point. A valid
 * ISBN-10/13 (separators tolerated) 301s to the owning Edition page anchored
 * at the matching Release row; a box-set ISBN 301s to its Bundle page. A
 * Release match wins any conflict — the resolution order lives in the Convex
 * query (`catalogPages.isbnLookup`). Search (`/search`) 302s recognized
 * ISBNs here, so this route owns resolution.
 *
 * The redirect is permanent because the target is a record identity, not a
 * query: an ISBN names exactly one Release (or Bundle) forever, and merges
 * already resolve to the survivor before the redirect is issued. Unknown or
 * invalid ISBNs 404.
 */
export const Route = createFileRoute("/isbn/$isbn")({
  loader: async ({ params }) => {
    const isbn = normalizeIsbn(params.isbn);
    if (isbn === null) throw notFound();
    const target = await fetchIsbnTarget({ data: isbn });
    if (!target) throw notFound();
    if (target.kind === "release") {
      throw redirect({
        href: `${editionPath(target.edition.publicId, target.edition.title)}#${target.anchor}`,
        statusCode: 301,
      });
    }
    throw redirect({
      href: bundlePath(target.bundle.publicId, target.bundle.name),
      statusCode: 301,
    });
  },
  component: () => null,
  notFoundComponent: IsbnNotFound,
});

function IsbnNotFound() {
  return (
    <main>
      <h1>ISBN not found</h1>
      <p className="notice">
        No release or bundle in the catalog carries this ISBN.{" "}
        <Link to="/search" search={{ q: "" }}>
          Search the catalog
        </Link>{" "}
        or <Link to="/">browse from the home page</Link>.
      </p>
    </main>
  );
}
