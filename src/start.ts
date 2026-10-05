import { clerkMiddleware } from "@clerk/tanstack-react-start/server";
import { createMiddleware, createStart } from "@tanstack/react-start";

import { authEnds, authStarts } from "~/server/timing";

// Clerk's request middleware authenticates every server request (session
// cookie → auth state for `auth()` in server functions) — spec §9. It is
// registered only when the Clerk secret key exists so the credential-less
// scaffold still builds and serves the public catalog; `clerkConfigured()` in
// src/server/auth.ts mirrors this condition. (`process` is server-only; on the
// client the option is irrelevant — request middleware runs on the server.)
const clerkConfigured = typeof process !== "undefined" && Boolean(process.env?.CLERK_SECRET_KEY);

// The Server-Timing `auth` span (server/timing.ts) runs from the middleware
// just before Clerk's to the one just after it, so the framework's own setup
// before the middleware chain is not counted as authentication.
const authTimingStart = createMiddleware().server(({ next }) => {
  authStarts();
  return next();
});
const authTimingEnd = createMiddleware().server(({ next }) => {
  authEnds();
  return next();
});

export const startInstance = createStart(() => ({
  requestMiddleware: clerkConfigured ? [authTimingStart, clerkMiddleware(), authTimingEnd] : [],
}));
