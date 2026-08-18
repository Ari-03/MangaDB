import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";

import { api } from "../../convex/_generated/api";
import { convexServerClient } from "~/server/convex";

// Scaffold proof (#21): the home page server-renders the result of a Convex
// query. Runs only on the server; the Convex URL never reaches the client
// bundle by way of this function.
const fetchCatalogStats = createServerFn({ method: "GET" }).handler(
  async () => {
    const convex = convexServerClient();
    if (!convex) return null;
    return await convex.query(api.catalog.stats, {});
  },
);

export const Route = createFileRoute("/")({
  loader: () => fetchCatalogStats(),
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
  const stats = Route.useLoaderData();

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

      <footer>
        Server-rendered on Cloudflare Workers; catalog counts fetched from
        Convex during SSR.
      </footer>
    </main>
  );
}
