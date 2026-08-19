/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as catalog from "../catalog.js";
import type * as catalogPages from "../catalogPages.js";
import type * as collection from "../collection.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_moderationFields from "../lib/moderationFields.js";
import type * as lib_publicIds from "../lib/publicIds.js";
import type * as lib_roles from "../lib/roles.js";
import type * as lib_titles from "../lib/titles.js";
import type * as lib_usernames from "../lib/usernames.js";
import type * as moderation from "../moderation.js";
import type * as publisher from "../publisher.js";
import type * as reading from "../reading.js";
import type * as releases from "../releases.js";
import type * as roles from "../roles.js";
import type * as seed from "../seed.js";
import type * as users from "../users.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  catalog: typeof catalog;
  catalogPages: typeof catalogPages;
  collection: typeof collection;
  "lib/auth": typeof lib_auth;
  "lib/moderationFields": typeof lib_moderationFields;
  "lib/publicIds": typeof lib_publicIds;
  "lib/roles": typeof lib_roles;
  "lib/titles": typeof lib_titles;
  "lib/usernames": typeof lib_usernames;
  moderation: typeof moderation;
  publisher: typeof publisher;
  reading: typeof reading;
  releases: typeof releases;
  roles: typeof roles;
  seed: typeof seed;
  users: typeof users;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
