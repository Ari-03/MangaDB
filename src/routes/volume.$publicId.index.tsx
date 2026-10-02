import { createFileRoute } from "@tanstack/react-router";

import { api } from "../../convex/_generated/api";
import { catalogQuery } from "~/lib/catalogData";
import { slugRedirect } from "~/lib/pageScaffold";
import { volumePath } from "~/lib/slug";

/** Slugless `/volume/{id}`: 301 to the canonical Volume URL. */
export const Route = createFileRoute("/volume/$publicId/")(
  slugRedirect(
    (publicId) => catalogQuery(api.catalogPages.volumePage, { publicId }),
    (page) => volumePath(page.volume.publicId, page.volume.title),
    { noun: "Volume" },
  ),
);
