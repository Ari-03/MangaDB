// HTTP routes of this deployment (its convex.site URL).
//
// /cover-upload receives a cover file for an upload the edit form started
// (coverUploads.ts uploadUrl, which hands out this URL with the upload's
// id and token). It stores the file and records the blob on that upload,
// so an upload only ever names a blob it stored. The form posts from the
// site's origin, hence the CORS answers; the token, not a cookie, is what
// lets the request in.

import { httpRouter } from "convex/server";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { MAX_COVER_UPLOAD_BYTES } from "./lib/moderationFields";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

/** A JSON answer the browser may read across origins. */
function reply(status: number, body: Record<string, unknown>) {
  return Response.json(body, { status, headers: CORS });
}

const http = httpRouter();

http.route({
  path: "/cover-upload",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const params = new URL(request.url).searchParams;
    const uploadId = params.get("upload");
    const token = params.get("token");
    if (!uploadId || !token) return reply(400, { message: "Not an upload URL." });
    const tooLarge = { message: "Over 10 MB. Export a smaller JPEG." };
    if (Number(request.headers.get("Content-Length")) > MAX_COVER_UPLOAD_BYTES) {
      return reply(413, tooLarge);
    }
    const file = await request.blob();
    if (file.size > MAX_COVER_UPLOAD_BYTES) return reply(413, tooLarge);
    const storageId = await ctx.storage.store(file);
    const kept = await ctx.runMutation(internal.coverUploads.stored, {
      uploadId,
      token,
      storageId,
    });
    if (!kept) {
      await ctx.storage.delete(storageId);
      return reply(403, { message: "This upload URL is used up or expired." });
    }
    return reply(200, { storageId });
  }),
});

http.route({
  path: "/cover-upload",
  method: "OPTIONS",
  handler: httpAction(async () => new Response(null, { status: 204, headers: CORS })),
});

export default http;
