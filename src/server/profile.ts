import { createServerFn } from "@tanstack/react-start";

import { api } from "../../convex/_generated/api";
import { convexServerClient } from "~/server/convex";

/**
 * SSR fetch for the public profile page (ticket #30): a public read, no auth
 * token — the profile shows exactly what its owner's visibility allows, the
 * same to everyone including the owner. Null when the username is unknown or
 * Convex is not configured.
 */
export const fetchPublicProfile = createServerFn({ method: "GET" })
  .validator((username: string) => username)
  .handler(async ({ data }) => {
    const convex = convexServerClient();
    if (!convex) return null;
    return await convex.query(api.sharing.publicProfile, { username: data });
  });

export type PublicProfileData = NonNullable<
  Awaited<ReturnType<typeof fetchPublicProfile>>
>;
