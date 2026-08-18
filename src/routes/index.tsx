import { createFileRoute, Link } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";

import { api } from "../../convex/_generated/api";
import { slugify } from "~/lib/slug";
import { convexServerClient } from "~/server/convex";

// Scaffold proof (#21): the home page server-renders the result of a Convex
// query. Runs only on the server; the Convex URL never reaches the client
// bundle by way of this function. #22 adds the browse list of Series so the
// catalog is reachable by link, not just by URL.
const fetchHomeData = createServerFn({ method: "GET" }).handler(async () => {
  const convex = convexServerClient();
  if (!convex) return null;
  const [stats, series] = await Promise.all([
    convex.query(api.catalog.stats, {}),
    convex.query(api.catalog.listSeries, {}),
  ]);
  return { stats, series };
});

export const Route = createFileRoute("/")({
  loader: () => fetchHomeData(),
  component: Home,
});

const LABELS = [
  ["publishers", "Publishers"],
  ["series", "Series"],
  ["volumes", "Volumes"],
  ["editions", "Editions"],
  ["releases", "Releases"],
] as const;

function Home() {
  const data = Route.useLoaderData();
  const stats = data?.stats ?? null;

  return (
    <main>
      <h1>MangaDB</h1>
      <p className="tagline">
        Track English manga volume releases: what volumes exist, when each
        edition comes out, and which ones you own, want, or have read.
      </p>

      {stats ? (
        <ul className="stats">
          {LABELS.map(([key, label]) => (
            <li key={key}>
              <span className="count">
                {stats[key].count}
                {stats[key].capped ? "+" : ""}
              </span>
              <span className="label">{label}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="notice">
          Convex is not configured. Set <code>VITE_CONVEX_URL</code> (see the
          README) and restart to server-render live catalog counts here.
        </p>
      )}

      {data && data.series.length > 0 ? (
        <section className="series-index">
          <h2>Series</h2>
          <ul className="series-links">
            {data.series.map((s) => (
              <li key={s.publicId}>
                <Link
                  to="/series/$publicId/$slug"
                  params={{ publicId: String(s.publicId), slug: slugify(s.title) }}
                >
                  {s.title}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <footer>
        Server-rendered on Cloudflare Workers; catalog counts fetched from
        Convex during SSR.
      </footer>
    </main>
  );
}
