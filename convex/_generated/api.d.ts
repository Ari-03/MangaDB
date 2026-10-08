/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as alternateEbooks from "../alternateEbooks.js";
import type * as ann from "../ann.js";
import type * as catalog from "../catalog.js";
import type * as catalogPages from "../catalogPages.js";
import type * as collection from "../collection.js";
import type * as comments from "../comments.js";
import type * as crons from "../crons.js";
import type * as favorites from "../favorites.js";
import type * as follows from "../follows.js";
import type * as heldBooks from "../heldBooks.js";
import type * as heldBundleCreation from "../heldBundleCreation.js";
import type * as heldRepair from "../heldRepair.js";
import type * as heldSourceParents from "../heldSourceParents.js";
import type * as importSources from "../importSources.js";
import type * as imports from "../imports.js";
import type * as kodansha from "../kodansha.js";
import type * as launch from "../launch.js";
import type * as lib_ann from "../lib/ann.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_authority from "../lib/authority.js";
import type * as lib_bookFacts from "../lib/bookFacts.js";
import type * as lib_bookTitle from "../lib/bookTitle.js";
import type * as lib_bounded from "../lib/bounded.js";
import type * as lib_boundedReads from "../lib/boundedReads.js";
import type * as lib_boxSets from "../lib/boxSets.js";
import type * as lib_canonicalDigital from "../lib/canonicalDigital.js";
import type * as lib_catalogTitle from "../lib/catalogTitle.js";
import type * as lib_commentPolicy from "../lib/commentPolicy.js";
import type * as lib_coverage from "../lib/coverage.js";
import type * as lib_covers from "../lib/covers.js";
import type * as lib_dates from "../lib/dates.js";
import type * as lib_declaredWork from "../lib/declaredWork.js";
import type * as lib_descriptionRepair from "../lib/descriptionRepair.js";
import type * as lib_descriptions from "../lib/descriptions.js";
import type * as lib_digitalSibling from "../lib/digitalSibling.js";
import type * as lib_digitalSiblingProofs from "../lib/digitalSiblingProofs.js";
import type * as lib_editionGroups from "../lib/editionGroups.js";
import type * as lib_editionRows from "../lib/editionRows.js";
import type * as lib_email from "../lib/email.js";
import type * as lib_episodeRouting from "../lib/episodeRouting.js";
import type * as lib_errors from "../lib/errors.js";
import type * as lib_features from "../lib/features.js";
import type * as lib_heldBooks from "../lib/heldBooks.js";
import type * as lib_heldPackageContents from "../lib/heldPackageContents.js";
import type * as lib_heldRepair from "../lib/heldRepair.js";
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
import type * as lib_olDump from "../lib/olDump.js";
import type * as lib_olSubtitleRefresh from "../lib/olSubtitleRefresh.js";
import type * as lib_openLibrary from "../lib/openLibrary.js";
import type * as lib_pathCombination from "../lib/pathCombination.js";
import type * as lib_pipeline from "../lib/pipeline.js";
import type * as lib_posthog from "../lib/posthog.js";
import type * as lib_prh from "../lib/prh.js";
import type * as lib_printings from "../lib/printings.js";
import type * as lib_proposalCreates from "../lib/proposalCreates.js";
import type * as lib_proposalWarnings from "../lib/proposalWarnings.js";
import type * as lib_publicIds from "../lib/publicIds.js";
import type * as lib_publisherIsbnBlocks from "../lib/publisherIsbnBlocks.js";
import type * as lib_publishers from "../lib/publishers.js";
import type * as lib_qa from "../lib/qa.js";
import type * as lib_ratingStats from "../lib/ratingStats.js";
import type * as lib_ratings from "../lib/ratings.js";
import type * as lib_reconcile from "../lib/reconcile.js";
import type * as lib_releaseIsbns from "../lib/releaseIsbns.js";
import type * as lib_repair_actor from "../lib/repair/actor.js";
import type * as lib_repair_audit from "../lib/repair/audit.js";
import type * as lib_repair_entries from "../lib/repair/entries.js";
import type * as lib_repair_gaps from "../lib/repair/gaps.js";
import type * as lib_repair_metrics from "../lib/repair/metrics.js";
import type * as lib_repair_ops from "../lib/repair/ops.js";
import type * as lib_reviewedCatalogCreation from "../lib/reviewedCatalogCreation.js";
import type * as lib_reviewedCatalogProducts from "../lib/reviewedCatalogProducts.js";
import type * as lib_roles from "../lib/roles.js";
import type * as lib_scope from "../lib/scope.js";
import type * as lib_scoreFormat from "../lib/scoreFormat.js";
import type * as lib_searchMatch from "../lib/searchMatch.js";
import type * as lib_sensitiveOps from "../lib/sensitiveOps.js";
import type * as lib_seriesStates from "../lib/seriesStates.js";
import type * as lib_seriesStats from "../lib/seriesStats.js";
import type * as lib_sevenSeas from "../lib/sevenSeas.js";
import type * as lib_sourceFormat from "../lib/sourceFormat.js";
import type * as lib_sourceSeriesParentRepair from "../lib/sourceSeriesParentRepair.js";
import type * as lib_standaloneIdentity from "../lib/standaloneIdentity.js";
import type * as lib_text from "../lib/text.js";
import type * as lib_titles from "../lib/titles.js";
import type * as lib_unmappedLink from "../lib/unmappedLink.js";
import type * as lib_unmappedProduct from "../lib/unmappedProduct.js";
import type * as lib_unmappedProductProofs from "../lib/unmappedProductProofs.js";
import type * as lib_unmatched from "../lib/unmatched.js";
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
import type * as printings from "../printings.js";
import type * as proposals from "../proposals.js";
import type * as publisher from "../publisher.js";
import type * as ratings from "../ratings.js";
import type * as reading from "../reading.js";
import type * as readingPaths from "../readingPaths.js";
import type * as releases from "../releases.js";
import type * as repair from "../repair.js";
import type * as repairTools from "../repairTools.js";
import type * as reports from "../reports.js";
import type * as reviews from "../reviews.js";
import type * as roles from "../roles.js";
import type * as scope from "../scope.js";
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
  alternateEbooks: typeof alternateEbooks;
  ann: typeof ann;
  catalog: typeof catalog;
  catalogPages: typeof catalogPages;
  collection: typeof collection;
  comments: typeof comments;
  crons: typeof crons;
  favorites: typeof favorites;
  follows: typeof follows;
  heldBooks: typeof heldBooks;
  heldBundleCreation: typeof heldBundleCreation;
  heldRepair: typeof heldRepair;
  heldSourceParents: typeof heldSourceParents;
  importSources: typeof importSources;
  imports: typeof imports;
  kodansha: typeof kodansha;
  launch: typeof launch;
  "lib/ann": typeof lib_ann;
  "lib/auth": typeof lib_auth;
  "lib/authority": typeof lib_authority;
  "lib/bookFacts": typeof lib_bookFacts;
  "lib/bookTitle": typeof lib_bookTitle;
  "lib/bounded": typeof lib_bounded;
  "lib/boundedReads": typeof lib_boundedReads;
  "lib/boxSets": typeof lib_boxSets;
  "lib/canonicalDigital": typeof lib_canonicalDigital;
  "lib/catalogTitle": typeof lib_catalogTitle;
  "lib/commentPolicy": typeof lib_commentPolicy;
  "lib/coverage": typeof lib_coverage;
  "lib/covers": typeof lib_covers;
  "lib/dates": typeof lib_dates;
  "lib/declaredWork": typeof lib_declaredWork;
  "lib/descriptionRepair": typeof lib_descriptionRepair;
  "lib/descriptions": typeof lib_descriptions;
  "lib/digitalSibling": typeof lib_digitalSibling;
  "lib/digitalSiblingProofs": typeof lib_digitalSiblingProofs;
  "lib/editionGroups": typeof lib_editionGroups;
  "lib/editionRows": typeof lib_editionRows;
  "lib/email": typeof lib_email;
  "lib/episodeRouting": typeof lib_episodeRouting;
  "lib/errors": typeof lib_errors;
  "lib/features": typeof lib_features;
  "lib/heldBooks": typeof lib_heldBooks;
  "lib/heldPackageContents": typeof lib_heldPackageContents;
  "lib/heldRepair": typeof lib_heldRepair;
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
  "lib/olDump": typeof lib_olDump;
  "lib/olSubtitleRefresh": typeof lib_olSubtitleRefresh;
  "lib/openLibrary": typeof lib_openLibrary;
  "lib/pathCombination": typeof lib_pathCombination;
  "lib/pipeline": typeof lib_pipeline;
  "lib/posthog": typeof lib_posthog;
  "lib/prh": typeof lib_prh;
  "lib/printings": typeof lib_printings;
  "lib/proposalCreates": typeof lib_proposalCreates;
  "lib/proposalWarnings": typeof lib_proposalWarnings;
  "lib/publicIds": typeof lib_publicIds;
  "lib/publisherIsbnBlocks": typeof lib_publisherIsbnBlocks;
  "lib/publishers": typeof lib_publishers;
  "lib/qa": typeof lib_qa;
  "lib/ratingStats": typeof lib_ratingStats;
  "lib/ratings": typeof lib_ratings;
  "lib/reconcile": typeof lib_reconcile;
  "lib/releaseIsbns": typeof lib_releaseIsbns;
  "lib/repair/actor": typeof lib_repair_actor;
  "lib/repair/audit": typeof lib_repair_audit;
  "lib/repair/entries": typeof lib_repair_entries;
  "lib/repair/gaps": typeof lib_repair_gaps;
  "lib/repair/metrics": typeof lib_repair_metrics;
  "lib/repair/ops": typeof lib_repair_ops;
  "lib/reviewedCatalogCreation": typeof lib_reviewedCatalogCreation;
  "lib/reviewedCatalogProducts": typeof lib_reviewedCatalogProducts;
  "lib/roles": typeof lib_roles;
  "lib/scope": typeof lib_scope;
  "lib/scoreFormat": typeof lib_scoreFormat;
  "lib/searchMatch": typeof lib_searchMatch;
  "lib/sensitiveOps": typeof lib_sensitiveOps;
  "lib/seriesStates": typeof lib_seriesStates;
  "lib/seriesStats": typeof lib_seriesStats;
  "lib/sevenSeas": typeof lib_sevenSeas;
  "lib/sourceFormat": typeof lib_sourceFormat;
  "lib/sourceSeriesParentRepair": typeof lib_sourceSeriesParentRepair;
  "lib/standaloneIdentity": typeof lib_standaloneIdentity;
  "lib/text": typeof lib_text;
  "lib/titles": typeof lib_titles;
  "lib/unmappedLink": typeof lib_unmappedLink;
  "lib/unmappedProduct": typeof lib_unmappedProduct;
  "lib/unmappedProductProofs": typeof lib_unmappedProductProofs;
  "lib/unmatched": typeof lib_unmatched;
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
  printings: typeof printings;
  proposals: typeof proposals;
  publisher: typeof publisher;
  ratings: typeof ratings;
  reading: typeof reading;
  readingPaths: typeof readingPaths;
  releases: typeof releases;
  repair: typeof repair;
  repairTools: typeof repairTools;
  reports: typeof reports;
  reviews: typeof reviews;
  roles: typeof roles;
  scope: typeof scope;
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
