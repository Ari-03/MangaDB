import { clerkMiddleware } from "@clerk/tanstack-react-start/server";
import { createStart } from "@tanstack/react-start";

// Clerk's request middleware authenticates every server request (session
// cookie → auth state for `auth()` in server functions) — spec §9. It is
// registered only when the Clerk secret key exists so the credential-less
// scaffold still builds and serves the public catalog; `clerkConfigured()` in
// src/server/auth.ts mirrors this condition. (`process` is server-only; on the
// client the option is irrelevant — request middleware runs on the server.)
const clerkConfigured =
  typeof process !== "undefined" && Boolean(process.env?.CLERK_SECRET_KEY);

export const startInstance = createStart(() => ({
  requestMiddleware: clerkConfigured ? [clerkMiddleware()] : [],
}));
