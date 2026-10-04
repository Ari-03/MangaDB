/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as ann from "../ann.js";
import type * as catalog from "../catalog.js";
import type * as catalogPages from "../catalogPages.js";
import type * as collection from "../collection.js";
import type * as comments from "../comments.js";
import type * as crons from "../crons.js";
import type * as favorites from "../favorites.js";
import type * as follows from "../follows.js";
import type * as importSources from "../importSources.js";
import type * as imports from "../imports.js";
import type * as kodansha from "../kodansha.js";
import type * as launch from "../launch.js";
import type * as lib_ann from "../lib/ann.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_authority from "../lib/authority.js";
import type * as lib_bookTitle from "../lib/bookTitle.js";
import type * as lib_catalogTitle from "../lib/catalogTitle.js";
import type * as lib_coverage from "../lib/coverage.js";
import type * as lib_covers from "../lib/covers.js";
import type * as lib_dates from "../lib/dates.js";
import type * as lib_descriptions from "../lib/descriptions.js";
import type * as lib_editionGroups from "../lib/editionGroups.js";
import type * as lib_editionRows from "../lib/editionRows.js";
import type * as lib_email from "../lib/email.js";
import type * as lib_errors from "../lib/errors.js";
import type * as lib_features from "../lib/features.js";
import type * as lib_http from "../lib/http.js";
import type * as lib_importRuns from "../lib/importRuns.js";
import type * as lib_isbn from "../lib/isbn.js";
import type * as lib_kodansha from "../lib/kodansha.js";
import type * as lib_matching from "../lib/matching.js";
import type * as lib_mature from "../lib/mature.js";
import type * as lib_merges from "../lib/merges.js";
import type * as lib_moderationFields from "../lib/moderationFields.js";
import type * as lib_observations from "../lib/observations.js";
import type * as lib_occ from "../lib/occ.js";
import type * as lib_openLibrary from "../lib/openLibrary.js";
import type * as lib_pipeline from "../lib/pipeline.js";
import type * as lib_posthog from "../lib/posthog.js";
import type * as lib_prh from "../lib/prh.js";
import type * as lib_proposalCreates from "../lib/proposalCreates.js";
import type * as lib_publicIds from "../lib/publicIds.js";
import type * as lib_publishers from "../lib/publishers.js";
import type * as lib_qa from "../lib/qa.js";
import type * as lib_ratingStats from "../lib/ratingStats.js";
import type * as lib_ratings from "../lib/ratings.js";
import type * as lib_reconcile from "../lib/reconcile.js";
import type * as lib_repair_audit from "../lib/repair/audit.js";
import type * as lib_repair_entries from "../lib/repair/entries.js";
import type * as lib_repair_metrics from "../lib/repair/metrics.js";
import type * as lib_repair_ops from "../lib/repair/ops.js";
import type * as lib_roles from "../lib/roles.js";
import type * as lib_scoreFormat from "../lib/scoreFormat.js";
import type * as lib_searchMatch from "../lib/searchMatch.js";
import type * as lib_sensitiveOps from "../lib/sensitiveOps.js";
import type * as lib_seriesStates from "../lib/seriesStates.js";
import type * as lib_sevenSeas from "../lib/sevenSeas.js";
import type * as lib_text from "../lib/text.js";
import type * as lib_titles from "../lib/titles.js";
import type * as lib_usernameLookup from "../lib/usernameLookup.js";
import type * as lib_usernames from "../lib/usernames.js";
import type * as lib_values from "../lib/values.js";
import type * as lib_yenPress from "../lib/yenPress.js";
import type * as moderation from "../moderation.js";
import type * as openLibrary from "../openLibrary.js";
import type * as packaging from "../packaging.js";
import type * as people from "../people.js";
import type * as placement from "../placement.js";
import type * as prh from "../prh.js";
import type * as proposals from "../proposals.js";
import type * as publisher from "../publisher.js";
import type * as ratings from "../ratings.js";
import type * as reading from "../reading.js";
import type * as releases from "../releases.js";
import type * as repair from "../repair.js";
import type * as reports from "../reports.js";
import type * as reviews from "../reviews.js";
import type * as roles from "../roles.js";
import type * as seed from "../seed.js";
import type * as sensitiveOps from "../sensitiveOps.js";
import type * as seo from "../seo.js";
import type * as seriesBrowse from "../seriesBrowse.js";
import type * as sevenSeas from "../sevenSeas.js";
import type * as sharing from "../sharing.js";
import type * as users from "../users.js";
import type * as yenPress from "../yenPress.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  ann: typeof ann;
  catalog: typeof catalog;
  catalogPages: typeof catalogPages;
  collection: typeof collection;
  comments: typeof comments;
  crons: typeof crons;
  favorites: typeof favorites;
  follows: typeof follows;
  importSources: typeof importSources;
  imports: typeof imports;
  kodansha: typeof kodansha;
  launch: typeof launch;
  "lib/ann": typeof lib_ann;
  "lib/auth": typeof lib_auth;
  "lib/authority": typeof lib_authority;
  "lib/bookTitle": typeof lib_bookTitle;
  "lib/catalogTitle": typeof lib_catalogTitle;
  "lib/coverage": typeof lib_coverage;
  "lib/covers": typeof lib_covers;
  "lib/dates": typeof lib_dates;
  "lib/descriptions": typeof lib_descriptions;
  "lib/editionGroups": typeof lib_editionGroups;
  "lib/editionRows": typeof lib_editionRows;
  "lib/email": typeof lib_email;
  "lib/errors": typeof lib_errors;
  "lib/features": typeof lib_features;
  "lib/http": typeof lib_http;
  "lib/importRuns": typeof lib_importRuns;
  "lib/isbn": typeof lib_isbn;
  "lib/kodansha": typeof lib_kodansha;
  "lib/matching": typeof lib_matching;
  "lib/mature": typeof lib_mature;
  "lib/merges": typeof lib_merges;
  "lib/moderationFields": typeof lib_moderationFields;
  "lib/observations": typeof lib_observations;
  "lib/occ": typeof lib_occ;
  "lib/openLibrary": typeof lib_openLibrary;
  "lib/pipeline": typeof lib_pipeline;
  "lib/posthog": typeof lib_posthog;
  "lib/prh": typeof lib_prh;
  "lib/proposalCreates": typeof lib_proposalCreates;
  "lib/publicIds": typeof lib_publicIds;
  "lib/publishers": typeof lib_publishers;
  "lib/qa": typeof lib_qa;
  "lib/ratingStats": typeof lib_ratingStats;
  "lib/ratings": typeof lib_ratings;
  "lib/reconcile": typeof lib_reconcile;
  "lib/repair/audit": typeof lib_repair_audit;
  "lib/repair/entries": typeof lib_repair_entries;
  "lib/repair/metrics": typeof lib_repair_metrics;
  "lib/repair/ops": typeof lib_repair_ops;
  "lib/roles": typeof lib_roles;
  "lib/scoreFormat": typeof lib_scoreFormat;
  "lib/searchMatch": typeof lib_searchMatch;
  "lib/sensitiveOps": typeof lib_sensitiveOps;
  "lib/seriesStates": typeof lib_seriesStates;
  "lib/sevenSeas": typeof lib_sevenSeas;
  "lib/text": typeof lib_text;
  "lib/titles": typeof lib_titles;
  "lib/usernameLookup": typeof lib_usernameLookup;
  "lib/usernames": typeof lib_usernames;
  "lib/values": typeof lib_values;
  "lib/yenPress": typeof lib_yenPress;
  moderation: typeof moderation;
  openLibrary: typeof openLibrary;
  packaging: typeof packaging;
  people: typeof people;
  placement: typeof placement;
  prh: typeof prh;
  proposals: typeof proposals;
  publisher: typeof publisher;
  ratings: typeof ratings;
  reading: typeof reading;
  releases: typeof releases;
  repair: typeof repair;
  reports: typeof reports;
  reviews: typeof reviews;
  roles: typeof roles;
  seed: typeof seed;
  sensitiveOps: typeof sensitiveOps;
  seo: typeof seo;
  seriesBrowse: typeof seriesBrowse;
  sevenSeas: typeof sevenSeas;
  sharing: typeof sharing;
  users: typeof users;
  yenPress: typeof yenPress;
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

export declare const components: {
  rateLimiter: import("@convex-dev/rate-limiter/_generated/component.js").ComponentApi<"rateLimiter">;
  posthog: import("@posthog/convex/_generated/component.js").ComponentApi<"posthog">;
};
