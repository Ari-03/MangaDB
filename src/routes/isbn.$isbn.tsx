import { createFileRoute, Link, notFound, redirect } from "@tanstack/react-router";

import { api } from "../../convex/_generated/api";
import { catalogQuery } from "~/lib/catalogData";
import { normalizeIsbn } from "~/lib/isbn";
import { bundlePath, editionPath } from "~/lib/slug";

/**
 * `/isbn/{isbn}` (spec §11): the ISBN entry point. A valid
 * ISBN-10/13 (separators tolerated) 301s to the owning Edition page anchored
 * at the matching Release row, whether it is the Release's own ISBN or one
 * of its Other Printings'; a box-set ISBN 301s to its Bundle page. A
 * Release match wins any conflict — the resolution order lives in the Convex
 * query (`catalogPages.isbnLookup`). Search (`/search`) 302s recognized
 * ISBNs here, so this route owns resolution.
 *
 * The redirect keeps the specified 301 (the ISBN's page is its Edition's or
 * Bundle's, and merges resolve to the survivor before it is issued), but it
 * is sent `Cache-Control: no-store`: which record an ISBN lands on can
 * change with a merge, a Split, a corrected ISBN or a recorded printing, so
 * no browser or cache may keep the answer. Unknown or invalid ISBNs 404.
 */
// A 301 is cacheable by default (RFC 9110 §15.4.2); no-store forbids it.
const uncached = { "Cache-Control": "no-store" };

export const Route = createFileRoute("/isbn/$isbn")({
  loader: async ({ params }) => {
    const isbn = normalizeIsbn(params.isbn);
    if (isbn === null) throw notFound();
    const target = await catalogQuery(api.catalogPages.isbnLookup, { isbn });
    if (!target) throw notFound();
    if (target.kind === "release") {
      throw redirect({
        href: `${editionPath(target.edition.publicId, target.edition.title)}#${target.anchor}`,
        statusCode: 301,
        headers: uncached,
      });
    }
    throw redirect({
      href: bundlePath(target.bundle.publicId, target.bundle.name),
      statusCode: 301,
      headers: uncached,
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
