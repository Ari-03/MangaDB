// Same-origin reverse proxy for PostHog (docs/configuration.md "Analytics (PostHog)"),
// after PostHog's Cloudflare Workers proxy guide. The browser SDK uses
// `/_s` as its api_host, so analytics requests are first-party and ad
// blockers that match *.posthog.com leave them alone.
//
// `/_s/static/*` (the SDK's lazy-loaded scripts) and `/_s/array/*` (remote
// config) go to the asset host and GETs there are kept in the edge cache;
// everything else (event batches, flags) goes to the ingest host. Cookies and auth
// headers never leave our origin, and X-Forwarded-For carries the visitor's
// IP so PostHog's GeoIP still works.
//
// This module has no Worker-only imports: the client reads the proxy path
// and UI host from it too, so a region move (US → EU) is the line below
// (plus POSTHOG_HOST on each Convex deployment, for backend events).

/**
 * PostHog Cloud region the project lives in: "us" or "eu". Keep in sync with
 * the Convex env var POSTHOG_HOST (backend events; unset means US).
 */
const POSTHOG_REGION = "us";

const INGEST_ORIGIN = `https://${POSTHOG_REGION}.i.posthog.com`;
const ASSET_ORIGIN = `https://${POSTHOG_REGION}-assets.i.posthog.com`;
/** The PostHog app itself, for toolbar and dashboard links (`ui_host`). */
export const POSTHOG_UI_HOST = `https://${POSTHOG_REGION}.posthog.com`;
/** Path prefix the proxy answers on; the browser SDK's default api_host. */
export const POSTHOG_PROXY_PATH = "/_s";

const ASSET_PATH = /^\/(static|array)\//;

/**
 * Handles `/_s/*`; returns null for every other request (bare `/_s`
 * included) so the Worker entry can fall through to the app.
 */
export async function posthogProxyResponse(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(`${POSTHOG_PROXY_PATH}/`)) return null;
  const path = url.pathname.slice(POSTHOG_PROXY_PATH.length) + url.search;
  if (!ASSET_PATH.test(path)) return forwardRequest(request, `${INGEST_ORIGIN}${path}`);
  // The edge cache only takes GETs; anything else goes straight through.
  return request.method === "GET"
    ? retrieveAsset(request, path)
    : forwardRequest(request, `${ASSET_ORIGIN}${path}`);
}

async function retrieveAsset(request: Request, path: string): Promise<Response> {
  const cache = caches.default;
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(`${ASSET_ORIGIN}${path}`);
  // Upstream Cache-Control decides how long the edge keeps it.
  if (response.ok) await cache.put(request, response.clone());
  return response;
}

/**
 * Largest upload the proxy passes on, matching PostHog's own request-size
 * limit for event batches. Replay snapshots are chunked well below it.
 */
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/**
 * Pass a request on to `target` without our cookies or auth. The visitor's
 * IP comes from Cloudflare's CF-Connecting-IP only: a client-sent
 * X-Forwarded-For is dropped, never trusted. Bodies stream through, so the
 * Worker never holds a whole upload; one over MAX_UPLOAD_BYTES is refused
 * (413) when declared, or cut off mid-stream when its length is unknown.
 */
async function forwardRequest(request: Request, target: string): Promise<Response> {
  const declared = Number(request.headers.get("content-length") ?? NaN);
  if (declared > MAX_UPLOAD_BYTES) return new Response("Payload too large", { status: 413 });
  const headers = new Headers(request.headers);
  headers.delete("cookie");
  headers.delete("authorization");
  headers.delete("host");
  headers.delete("x-forwarded-for");
  const ip = request.headers.get("CF-Connecting-IP");
  if (ip) headers.set("X-Forwarded-For", ip);
  const body =
    request.body && !Number.isFinite(declared) ? request.body.pipeThrough(uploadLimit()) : request.body;
  return fetch(target, {
    method: request.method,
    headers,
    body,
    redirect: request.redirect,
  });
}

/** Passes bytes through until MAX_UPLOAD_BYTES, then errors the stream. */
function uploadLimit(): TransformStream<Uint8Array, Uint8Array> {
  let seen = 0;
  return new TransformStream({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > MAX_UPLOAD_BYTES) controller.error(new Error("Upload too large"));
      else controller.enqueue(chunk);
    },
  });
}
