// Username policy (spec §8, ticket #26): required at first sign-in, unique
// case-insensitively via a normalized copy, changeable with immediate release
// of the old name. The reserved list lives here in code — an open vocabulary
// per the schema's convention, so extending it is never a schema event.

export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 20;

// Letters, digits, underscore; must start with a letter or digit. Keeps
// /u/{username} URLs unambiguous (no encoding, no lookalike separators).
const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_]*$/;

/**
 * The single normalization used for uniqueness checks and index lookups.
 * NFKC folds Unicode compatibility forms (fullwidth digits etc.) before the
 * ASCII-only pattern check; lowercase makes uniqueness case-insensitive.
 */
export function normalizeUsername(username: string): string {
  return username.normalize("NFKC").trim().toLowerCase();
}

// Names that could impersonate the site/staff or collide with route words and
// generated UI copy. Checked against the normalized form.
export const RESERVED_USERNAMES: ReadonlySet<string> = new Set([
  // site & staff impersonation
  "mangadb",
  "official",
  "staff",
  "team",
  "admin",
  "admins",
  "administrator",
  "administrators",
  "moderator",
  "moderators",
  "mod",
  "mods",
  "editor",
  "editors",
  "root",
  "system",
  "support",
  "webmaster",
  // route words and app surfaces (flat URL namespace, spec §11)
  "about",
  "account",
  "api",
  "auth",
  "bundle",
  "bundles",
  "calendar",
  "contact",
  "edition",
  "editions",
  "help",
  "isbn",
  "login",
  "logout",
  "me",
  "publisher",
  "publishers",
  "release",
  "releases",
  "search",
  "series",
  "settings",
  "sign_in",
  "sign_up",
  "signin",
  "signup",
  "sitemap",
  "sources",
  "terms",
  "privacy",
  "u",
  "user",
  "users",
  "username",
  "volume",
  "volumes",
  // confusing sentinels
  "anonymous",
  "deleted",
  "everyone",
  "here",
  "nobody",
  "null",
  "undefined",
  "unknown",
]);

export type UsernameValidation =
  | { ok: true; normalized: string }
  | { ok: false; code: "invalid" | "reserved"; message: string };

/** Full policy check; returns the normalized copy to store alongside the name. */
export function validateUsername(username: string): UsernameValidation {
  const normalized = normalizeUsername(username);
  if (
    normalized.length < USERNAME_MIN_LENGTH ||
    normalized.length > USERNAME_MAX_LENGTH ||
    !USERNAME_PATTERN.test(username.trim())
  ) {
    return {
      ok: false,
      code: "invalid",
      message: `Usernames are ${USERNAME_MIN_LENGTH}–${USERNAME_MAX_LENGTH} characters: letters, digits, and underscores, starting with a letter or digit.`,
    };
  }
  if (RESERVED_USERNAMES.has(normalized)) {
    return {
      ok: false,
      code: "reserved",
      message: "That username is reserved.",
    };
  }
  return { ok: true, normalized };
}
