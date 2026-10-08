// What a catalog page shows around a cover or a description for editing
// and crediting it: the source footer every reader sees under a blurb, and
// the data team's links beside the art and the text. Each link goes to the
// record that owns what is shown (convex/catalogPages.ts `Owner`), never a
// guess: Moderators to the direct edit, Editors to the proposal form, both
// at the matching section (`#cover`, `#description`). Readers without a
// data-team role see no links.

import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import type { Owner } from "../../convex/catalogPages";
import type { Citation } from "../../convex/lib/moderationFields";
import { slugParams } from "~/lib/slug";
import { useIsDataTeam, useIsModerator } from "~/lib/viewer";

/** The section of the edit form a link lands on. */
export type EditAnchor = "cover" | "description";

/**
 * "Source: Kodansha USA" under a blurb, linked to the page the text came
 * from (convex/lib/attribution.ts); nothing when no source is on record.
 */
export function BlurbSource({ attribution }: { attribution: Citation | null | undefined }) {
  if (!attribution) return null;
  return (
    <p className="blurb-source">
      Source:{" "}
      <a href={attribution.url} rel="noreferrer">
        {attribution.sourceName}
      </a>
    </p>
  );
}

/** One link to `owner`'s edit or propose form at `anchor`, by the viewer's role. */
export function ContextEditLink({
  owner,
  anchor,
  children,
}: {
  owner: Pick<Owner, "type" | "key" | "label">;
  anchor: EditAnchor;
  children: ReactNode;
}) {
  const isModerator = useIsModerator();
  return (
    <Link
      to={isModerator ? "/mod/edit/$type/$key" : "/mod/propose/$type/$key"}
      params={{ type: owner.type, key: owner.key }}
      hash={anchor}
      title={`Edit ${owner.label}`}
    >
      {children}
    </Link>
  );
}

/**
 * The data team's row of edit links under a blurb or a cover, with an
 * optional note before them ("This is the series synopsis."). Nothing for
 * other readers.
 */
export function EditLinks({
  note,
  children,
  id,
}: {
  note?: ReactNode;
  children: ReactNode;
  id?: string;
}) {
  const isDataTeam = useIsDataTeam();
  if (!isDataTeam) return null;
  return (
    <p className="mod-edit-link context-edit" id={id}>
      {note ? <span>{note}</span> : null}
      {children}
    </p>
  );
}

/**
 * A Volume or Series page's cover link: the art there is one Edition's,
 * so it leads to that Edition's page, where the cover link names the
 * Release that holds it (`#cover`).
 */
export function EditionCoverLink({ edition }: { edition: { publicId: number; title: string } }) {
  return (
    <EditLinks>
      <Link
        to="/edition/$publicId/$slug"
        params={slugParams(edition.publicId, edition.title)}
        hash="cover"
        title={`Edit on the ${edition.title} page`}
      >
        Change cover
      </Link>
    </EditLinks>
  );
}
