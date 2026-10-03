import { createFileRoute } from "@tanstack/react-router";

import { api } from "../../convex/_generated/api";
import { catalogQuery } from "~/lib/catalogData";
import { slugRedirect } from "~/lib/pageScaffold";
import { seriesPath } from "~/lib/slug";

/** Slugless `/series/{id}`: 301 to the canonical Series URL. */
export const Route = createFileRoute("/series/$publicId/")(
  slugRedirect(
    (publicId) => catalogQuery(api.catalog.seriesPage, { publicId }),
    (page) => seriesPath(page.series.publicId, page.series.title),
    { noun: "Series" },
  ),
);
