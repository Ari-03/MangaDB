import { auth } from "@clerk/tanstack-react-start/server";

/**
 * Server-only Clerk helpers (spec §9). `auth()` reads the request state that
 * clerkMiddleware (src/start.ts) attached, so both are gated on the same
 * condition: without Clerk credentials the whole app is simply signed out and
 * the public catalog keeps working.
 */
export function clerkConfigured(): boolean {
  return Boolean(process.env.CLERK_SECRET_KEY);
}

export type SsrAuth = {
  /** Clerk subject (user id); null when signed out. */
  userId: string | null;
  /** Clerk JWT minted from the "convex" template, for ConvexHttpClient.setAuth. */
  convexToken: string | null;
};

/** The viewer's auth state for this server request. */
export async function ssrAuth(): Promise<SsrAuth> {
  if (!clerkConfigured()) return { userId: null, convexToken: null };
  const authState = await auth();
  if (!authState.userId) return { userId: null, convexToken: null };
  const convexToken = await authState.getToken({ template: "convex" });
  return { userId: authState.userId, convexToken };
}
