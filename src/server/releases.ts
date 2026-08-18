import { createServerFn } from "@tanstack/react-start";

import { api } from "../../convex/_generated/api";
import { convexServerClient } from "~/server/convex";

/**
 * SSR fetch for the Releases browser (ticket #24): one public month-window
 * query serves both the Agenda and the Month Grid. Returns null when Convex
 * is not configured, so the routes render a setup notice instead of crashing.
 */
export const fetchMonthReleases = createServerFn({ method: "GET" })
  .validator(
    (args: {
      year: number;
      month: number;
      format?: "physical" | "digital";
      publisher?: string;
    }) => args,
  )
  .handler(async ({ data }) => {
    const convex = convexServerClient();
    if (!convex) return null;
    return await convex.query(api.releases.monthBrowse, data);
  });

export type MonthReleasesData = NonNullable<
  Awaited<ReturnType<typeof fetchMonthReleases>>
>;
export type BrowseRelease = MonthReleasesData["releases"][number];
