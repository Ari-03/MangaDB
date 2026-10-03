import { createFileRoute } from "@tanstack/react-router";

import { api } from "../../convex/_generated/api";
import { catalogQuery } from "~/lib/catalogData";
import { slugRedirect } from "~/lib/pageScaffold";
import { editionPath } from "~/lib/slug";

/** Slugless `/edition/{id}`: 301 to the canonical Edition URL. */
export const Route = createFileRoute("/edition/$publicId/")(
  slugRedirect(
    (publicId) => catalogQuery(api.catalogPages.editionPage, { publicId }),
    (page) => editionPath(page.edition.publicId, page.edition.title),
    { noun: "Edition" },
  ),
);
