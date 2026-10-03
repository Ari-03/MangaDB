// The coded error every mutation refuses with: clients read `code` to branch
// and show `message` to the user.

import { ConvexError } from "convex/values";

/**
 * Throw `{ code, message }` as a ConvexError. A function declaration with a
 * `never` return, so a guard like `if (!doc) fail(...)` narrows `doc`.
 */
export function fail(code: string, message: string): never {
  throw new ConvexError({ code, message });
}
