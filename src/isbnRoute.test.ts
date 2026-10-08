// `/isbn/{isbn}` (src/routes/isbn.$isbn.tsx) through a server-side router
// load: a Release or Bundle match 301s to its page with
// `Cache-Control: no-store`, since which record an ISBN lands on can change
// (a merge, a Split, a corrected ISBN, a recorded printing). The Convex
// lookup is stubbed; its own tests are convex/printings.test.ts.

import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

const catalogQuery = vi.hoisted(() => vi.fn());
vi.mock("~/lib/catalogData", () => ({ catalogQuery }));
const { Route } = await import("./routes/isbn.$isbn");

// The route's own loader, mounted where the generated tree mounts it.
const rootRoute = createRootRoute();
const routeTree = rootRoute.addChildren([
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/isbn/$isbn",
    loader: Route.options.loader,
  }),
]);

/** The server's answer for `path`: the redirect it sends, or the status it renders. */
async function serve(path: string) {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
    isServer: true,
  });
  await router.load();
  const result = router._serverResult;
  if (result?.type !== "redirect") return { status: result?.status };
  const { status, headers } = result.redirect;
  return {
    status,
    location: headers.get("Location"),
    cacheControl: headers.get("Cache-Control"),
  };
}

beforeEach(() => catalogQuery.mockReset());

describe("/isbn/{isbn}", () => {
  it.each([
    ["an ISBN-13", "9781591160342", "9781591160342"],
    ["an ISBN-10", "1591160340", "1591160340"],
    ["a hyphenated ISBN-10", "1-59116-034-0", "1591160340"],
  ])("301s %s's Release to its Edition row, uncached", async (_, segment, looked) => {
    catalogQuery.mockResolvedValue({
      kind: "release",
      edition: { publicId: 880, title: "Vagabond" },
      anchor: "9781421519111",
    });
    expect(await serve(`/isbn/${segment}`)).toEqual({
      status: 301,
      location: "/edition/880/vagabond#9781421519111",
      cacheControl: "no-store",
    });
    expect(catalogQuery).toHaveBeenCalledWith(expect.anything(), { isbn: looked });
  });

  it("301s a box set's ISBN to its Bundle page, uncached", async () => {
    catalogQuery.mockResolvedValue({
      kind: "bundle",
      bundle: { publicId: 9100, name: "Vagabond Box Set" },
    });
    expect(await serve("/isbn/9781421599991")).toEqual({
      status: 301,
      location: "/bundle/9100/vagabond-box-set",
      cacheControl: "no-store",
    });
  });

  it("404s an ISBN no record carries, and one that is not an ISBN without a lookup", async () => {
    catalogQuery.mockResolvedValue(null);
    expect(await serve("/isbn/9781591160359")).toEqual({ status: 404 });
    expect(await serve("/isbn/9781591160343")).toEqual({ status: 404 });
    expect(catalogQuery).toHaveBeenCalledTimes(1);
  });
});
