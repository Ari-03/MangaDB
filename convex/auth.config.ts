// Convex ↔ Clerk OIDC wiring (spec §9). CLERK_JWT_ISSUER_DOMAIN is set on the
// Convex deployment (dashboard → Settings → Environment Variables) to the
// issuer domain of the Clerk JWT template named "convex". The fallback keeps
// local codegen/tests working before Clerk credentials exist.
export default {
  providers: [
    {
      domain:
        process.env.CLERK_JWT_ISSUER_DOMAIN ??
        "https://placeholder.clerk.accounts.dev",
      applicationID: "convex",
    },
  ],
};
