/** The generic failure line for a write that did not say why it failed. */
export const TRY_AGAIN = "That didn't go through. Try again.";

/**
 * A readable message out of any thrown Convex function error: the
 * ConvexError's `message`, or its data when the data is a plain string.
 * A rate-limiter rejection (`kind: "RateLimited"`, no message) reads as
 * `rateLimited`; anything else (network failures included) as `fallback`.
 */
export function mutationErrorMessage(
  err: unknown,
  fallback = TRY_AGAIN,
  rateLimited = "Slow down — you have hit the per-user rate limit. Try again in a few minutes.",
): string {
  const data = (err as { data?: unknown })?.data;
  if (typeof data === "object" && data !== null) {
    const record = data as { message?: unknown; kind?: unknown };
    if (record.kind === "RateLimited") return rateLimited;
    if (typeof record.message === "string") return record.message;
  }
  if (typeof data === "string") return data;
  return fallback;
}
