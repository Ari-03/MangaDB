/**
 * Canonical-host policy (spec §11–12): the apex `mangadb.org` is canonical,
 * `www` 301s to it, and HTTP upgrades to HTTPS. Pure function so it is unit
 * testable outside the Workers runtime.
 *
 * Only requests whose hostname is the canonical host or its `www.` twin are
 * ever redirected — `*.workers.dev` previews and local dev pass through
 * untouched. An empty/unset canonical host disables redirects entirely.
 */
export function canonicalRedirect(
  request: Request,
  canonicalHost: string | undefined,
): Response | null {
  if (!canonicalHost) return null;

  const url = new URL(request.url);
  const isCanonical = url.hostname === canonicalHost;
  const isWww = url.hostname === `www.${canonicalHost}`;
  if (!isCanonical && !isWww) return null;

  const needsHost = isWww;
  const needsHttps = url.protocol !== "https:";
  if (!needsHost && !needsHttps) return null;

  url.hostname = canonicalHost;
  url.protocol = "https:";
  url.port = "";
  return Response.redirect(url.toString(), 301);
}
