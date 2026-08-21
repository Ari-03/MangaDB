// Temporary diagnostic: what does a third-party endpoint return when fetched
// from this Convex deployment's egress IPs? Delete after use.
import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { USER_AGENT } from "./lib/http";

export const probe = internalAction({
  args: { url: v.string(), browserUa: v.optional(v.boolean()) },
  handler: async (_ctx, { url, browserUa }) => {
    const ua = browserUa
      ? "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
      : USER_AGENT;
    const res = await fetch(url, { headers: { "User-Agent": ua } });
    const body = await res.text();
    return {
      status: res.status,
      contentType: res.headers.get("content-type"),
      server: res.headers.get("server"),
      mitigated: res.headers.get("cf-mitigated"),
      head: body.slice(0, 400),
    };
  },
});
