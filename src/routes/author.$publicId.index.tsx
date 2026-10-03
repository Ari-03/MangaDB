import { createFileRoute } from "@tanstack/react-router";

import { api } from "../../convex/_generated/api";
import { catalogQuery } from "~/lib/catalogData";
import { slugRedirect } from "~/lib/pageScaffold";
import { authorPath } from "~/lib/slug";

/** Slugless `/author/{id}`: 301 to the canonical author URL. */
export const Route = createFileRoute("/author/$publicId/")(
  slugRedirect(
    (publicId) => catalogQuery(api.people.authorPage, { publicId }),
    (page) => authorPath(page.author.publicId, page.author.name),
    { noun: "Author", browse: "authors" },
  ),
);
