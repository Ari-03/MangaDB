// Page scaffolding the catalog and mod routes share: the visible breadcrumb
// trail, the 404 body of a catalog record, and the slugless-URL redirect.

import { Link, notFound, redirect } from "@tanstack/react-router";
import { Fragment, type ReactElement } from "react";

import { parsePublicId } from "~/lib/slug";

/**
 * The visible trail under the masthead: "MangaDB / …". A string crumb is
 * plain text (usually the current page); pass a `<Link>` for one that leads
 * somewhere. The JSON-LD twin is pageHead's `breadcrumbs` (lib/seo.ts).
 */
export function Breadcrumbs({ trail }: { trail: Array<string | ReactElement> }) {
  return (
    <nav className="breadcrumbs" aria-label="Breadcrumb">
      <Link to="/">MangaDB</Link>
      {trail.map((crumb, i) => (
        <Fragment key={i}>
          {" "}
          <span aria-hidden="true">/</span>{" "}
          {typeof crumb === "string" ? <span>{crumb}</span> : crumb}
        </Fragment>
      ))}
    </nav>
  );
}

export type NotFoundProps = {
  /** The record kind as a heading word: "Series", "Volume", "Author"… */
  noun: string;
  /** A page whose 404 keeps its own `{kind}-page` / `{kind}-title` classes. */
  kind?: "series" | "volume";
  /** Where the way back leads: the catalog home, or the Authors tab. */
  browse?: "catalog" | "authors";
};

/** The 404 body of a catalog record route: "{Noun} not found" and a way back. */
export function NotFound({ noun, kind, browse = "catalog" }: NotFoundProps) {
  return (
    <main className={kind && `${kind}-page`}>
      <h1 className={kind && `${kind}-title`}>{`${noun} not found`}</h1>
      <p className="notice">
        {`No ${noun.toLowerCase()} lives at this address. `}
        {browse === "authors" ? (
          <Link to="/authors">Browse authors</Link>
        ) : (
          <Link to="/">Browse the catalog</Link>
        )}
        .
      </p>
    </main>
  );
}

/**
 * Route options for a slugless `/{entity}/{id}` URL (and a merged loser's
 * ID): a permanent redirect to the record's canonical `/{entity}/{id}/{slug}`
 * (spec §11), or a 404. The slug is cosmetic; the ID alone identifies the
 * record. `fetchPage` returns null for an unknown ID or an unconfigured
 * deployment.
 */
export function slugRedirect<Page>(
  fetchPage: (publicId: number) => Promise<Page | null>,
  pathOf: (page: Page) => string,
  notFoundBody: NotFoundProps,
) {
  return {
    loader: async ({ params }: { params: { publicId: string } }): Promise<never> => {
      const publicId = parsePublicId(params.publicId);
      if (publicId === null) throw notFound();
      const page = await fetchPage(publicId);
      if (!page) throw notFound();
      throw redirect({ href: pathOf(page), statusCode: 301 });
    },
    component: () => null,
    notFoundComponent: () => <NotFound {...notFoundBody} />,
  };
}
