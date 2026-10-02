// The signed-in viewer as components read it (convex/users.ts `viewer`).
// Hooks here only work under the Convex provider; callers render nothing
// in the unconfigured mode before reaching them.

import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";

import { api } from "../../convex/_generated/api";

/** users.viewer for a signed-in viewer whose username claim is complete. */
export type ReadyViewer = Extract<
  NonNullable<FunctionReturnType<typeof api.users.viewer>>,
  { needsUsername: false }
>;

/**
 * The signed-in viewer with a claimed username; null while loading, signed
 * out, or username pending. Components that tell those states apart read
 * api.users.viewer directly.
 */
export function useReadyViewer(): ReadyViewer | null {
  const viewer = useQuery(api.users.viewer, {});
  return viewer && !viewer.needsUsername ? viewer : null;
}

/** True when the viewer holds the Moderator or Administrator role. */
export function useIsModerator(): boolean {
  const role = useReadyViewer()?.role;
  return role === "moderator" || role === "administrator";
}

/** True when the viewer holds any data-team role (Editor and up). */
export function useIsDataTeam(): boolean {
  const role = useReadyViewer()?.role;
  return role === "editor" || role === "moderator" || role === "administrator";
}
