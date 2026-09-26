import { createFileRoute, Link, notFound } from "@tanstack/react-router";

import { currentMonth, monthParam, monthTitle, parseMonthParam } from "~/lib/month";
import { PublishersBoard } from "~/lib/publishersBoard";
import {
  breadcrumbListJsonLd,
  jsonLdScript,
  pageHead,
  SITE_NAME,
} from "~/lib/seo";
import { fetchPublishersBoard } from "~/server/publisher";

/**
 * `/publishers/{yyyy-mm}` — the Publishers board for any month, so last
 * month, next month, or any other is a shareable URL. Same indexing policy
 * as the Releases browser's month pages (spec §11): the bare month URL is
 * indexable and canonical to itself; the route takes no query params.
 */
export const Route = createFileRoute("/publishers/$month")({
  loader: async ({ params }) => {
    const anchor = parseMonthParam(params.month);
    if (!anchor) throw notFound();
    const data = await fetchPublishersBoard({ data: anchor });
    return { anchor, today: currentMonth(), data };
  },
  head: ({ loaderData }) => {
    if (!loaderData) return {};
    const month = monthTitle(loaderData.anchor);
    return {
      ...pageHead({
        title: `English Manga Publishers – ${month} Releases | ${SITE_NAME}`,
        description: `What every English manga publisher released in ${month}: release counts, new series, formats, and covers, publisher by publisher.`,
        path: `/publishers/${monthParam(loaderData.anchor)}`,
      }),
      scripts: [
        jsonLdScript(
          breadcrumbListJsonLd([
            { name: "MangaDB", path: "/" },
            { name: "Publishers", path: "/publishers" },
            { name: month },
          ]),
        ),
      ],
    };
  },
  component: MonthBoardPage,
  notFoundComponent: MonthNotFound,
});

function MonthNotFound() {
  return (
    <main className="publishers-page">
      <div className="page-head">
        <div>
          <p className="page-kicker">English manga publishers</p>
          <h1 className="page-title">Month not found</h1>
        </div>
      </div>
      <p className="notice">
        Months live at <code>/publishers/{"{yyyy-mm}"}</code>, like{" "}
        <code>/publishers/{monthParam(currentMonth())}</code>.{" "}
        <Link to="/publishers">See this month's publishers</Link>.
      </p>
    </main>
  );
}

function MonthBoardPage() {
  const { anchor, today, data } = Route.useLoaderData();
  return <PublishersBoard anchor={anchor} today={today} data={data} />;
}
