import { createFileRoute } from "@tanstack/react-router";

import { api } from "../../convex/_generated/api";
import { catalogQuery } from "~/lib/catalogData";
import { showMature } from "~/lib/mature";
import { currentMonth } from "~/lib/month";
import { PublishersBoard } from "~/lib/publishersBoard";
import { pageHead, SITE_NAME } from "~/lib/seo";

/**
 * `/publishers` — the Publishers board for the current month: one card per
 * Publisher releasing this month, busiest first, then the A–Z directory of
 * every Publisher. Other months live at `/publishers/{yyyy-mm}`, mirroring
 * the Releases browser's month URLs. Indexable, canonical to itself.
 */
export const Route = createFileRoute("/publishers/")({
  loader: async () => {
    // The current month (UTC) is computed on the server so SSR and
    // hydration agree, like the Release Agenda.
    const anchor = currentMonth();
    const data = await catalogQuery(api.publisher.monthBoard, {
      ...anchor,
      showMature: showMature(),
    });
    return { anchor, data };
  },
  head: () =>
    pageHead({
      title: `English Manga Publishers – This Month's Releases | ${SITE_NAME}`,
      description:
        "What every English manga publisher is releasing this month: release counts, new series, formats, and covers, plus the A–Z publisher directory.",
      path: "/publishers",
      breadcrumbs: [{ name: "Publishers" }],
    }),
  component: PublishersPage,
});

function PublishersPage() {
  const { anchor, data } = Route.useLoaderData();
  return <PublishersBoard anchor={anchor} today={anchor} data={data} />;
}
