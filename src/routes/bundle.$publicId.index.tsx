import { createFileRoute } from "@tanstack/react-router";

import { api } from "../../convex/_generated/api";
import { catalogQuery } from "~/lib/catalogData";
import { slugRedirect } from "~/lib/pageScaffold";
import { bundlePath } from "~/lib/slug";

/** Slugless `/bundle/{id}`: 301 to the canonical Bundle URL. */
export const Route = createFileRoute("/bundle/$publicId/")(
  slugRedirect(
    (publicId) => catalogQuery(api.catalogPages.bundlePage, { publicId }),
    (page) => bundlePath(page.bundle.publicId, page.bundle.name),
    { noun: "Bundle" },
  ),
);
