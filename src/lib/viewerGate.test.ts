// The Series page's signed-in controls and its shelf overlay under each
// Clerk session state (lib/viewer.ts useViewerQuery): an anonymous visitor
// subscribes to no viewer-only query and sees the signed-out page at once;
// a visitor whose Clerk session is loading subscribes to none either and
// sees no signed-out prompt flash by; a signed-in reader subscribes at once
// but is shown nothing (neither answers the client held from before nor a
// sign-in prompt) until Convex accepts the token, then gets the controls,
// or the signed-out page should Convex refuse it. The components run as plain functions on the test.react.ts
// harness, the signed-in answers taken from convex-test; the real providers
// are in viewerGate.provider.test.ts. The revision history, public,
// subscribes only once opened.

import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import {
  insertCoverage,
  insertEdition,
  insertPublisher,
  insertRelease,
  insertSeries,
  insertVolume,
} from "../../convex/test.factories";
import { makeT, reader, withUser } from "../../convex/test.helpers";
import { AUTH, harness, mount, resetHarness, setQuery, text, type Host } from "./test.react";

vi.mock("convex/react", async () => (await import("./test.react")).backendHooks);
vi.mock("@clerk/tanstack-react-start", async () => (await import("./test.react")).clerkHooks);
vi.mock("@tanstack/react-router", () => ({ Link: ({ children }: { children?: ReactNode }) => children }));
vi.mock("~/lib/analytics", () => ({ track: () => undefined }));
vi.mock("~/lib/mature", () => ({ useArtConcealed: () => false }));

const { SeriesFollowControls } = await import("./follows");
const { FavoriteButton } = await import("./favorites");
const { ReviewsSection, TakePanel } = await import("./reviews");
const { SeriesReadingControls, SeriesReadingProgress, VolumeReadCount, ReleasePassControls } = await import("./reading");
const { SeriesVisibilityControls } = await import("./sharing");
const { ReleaseCollectionControls } = await import("./collection");
const { RecordHistory } = await import("./moderation");
const { useSeriesOverlay } = await import("./quickActions");
const { useReadyViewer } = await import("./viewer");

const target = { kind: "series" as const, publicId: 1 };

// Every viewer-only query the Series page's controls read.
const PERSONAL = [
  "users:viewer",
  "ratings:mine",
  "reviews:mine",
  "reviews:hiddenList",
  "follows:seriesFollow",
  "favorites:isFavorite",
  "sharing:seriesVisibility",
  "reading:seriesTracking",
  "reading:passForRelease",
  "collection:entryForRelease",
  "collection:seriesEntries",
];

/** The reading paths' shelf, reduced to the overlay every cover reads. */
function Shelf({ seriesPublicId }: { seriesPublicId: number }) {
  useSeriesOverlay(seriesPublicId);
  return null;
}

/** The signed-in parts of a Series page, as it lays them out, with the Reviews section on. */
function seriesPage(releaseId: Id<"releases">) {
  return createElement(
    "div",
    null,
    createElement(
      TakePanel,
      { target, noun: "series" },
      createElement(SeriesFollowControls, { seriesPublicId: 1 }),
      createElement(FavoriteButton, { target }),
    ),
    createElement(SeriesReadingControls, { seriesPublicId: 1 }),
    createElement(SeriesReadingProgress, { seriesPublicId: 1, volumeCount: 1 }),
    createElement(SeriesVisibilityControls, { seriesPublicId: 1 }),
    createElement(VolumeReadCount, { seriesPublicId: 1, volumePublicId: 11 }),
    createElement(ReleaseCollectionControls, { releaseId }),
    createElement(ReleasePassControls, { releaseId }),
    createElement(Shelf, { seriesPublicId: 1 }),
    createElement(ReviewsSection, { target, initial: { items: [], hasMore: false }, noun: "series" }),
  );
}

/** Vinland Saga (Series 1), Volume 11, and one Edition with a Release of it. */
async function seed() {
  const t = makeT();
  const releaseId = await t.run(async (ctx) => {
    const publisherId = await insertPublisher(ctx, { name: "Kodansha", slug: "kodansha" });
    const seriesId = await insertSeries(ctx, { publicId: 1, title: "Vinland Saga" });
    const volumeId = await insertVolume(ctx, { publicId: 11, seriesId });
    const editionId = await insertEdition(ctx, { publisherId });
    await insertCoverage(ctx, { editionId, volumeId });
    return await insertRelease(ctx, { editionId, publisherId, seriesIds: [seriesId] });
  });
  return { t, releaseId };
}

const buttons = (tree: Host[]) =>
  tree.filter((host) => host.type === "button").map((host) => text(host.props.children));
const pageText = (tree: Host[]) => tree.map((host) => (typeof host.props.children === "string" ? host.props.children : "")).join(" ");

beforeEach(resetHarness);

describe("viewer-only queries follow the Clerk session", () => {
  it("an anonymous visitor subscribes to none and sees the signed-out page", async () => {
    const { releaseId } = await seed();
    harness.auth = AUTH.signedOut;
    const tree = mount(() => seriesPage(releaseId));
    expect([...harness.subscribed].filter((name) => PERSONAL.includes(name))).toEqual([]);
    // Only the public Reviews list is read.
    expect([...harness.subscribed]).toEqual(["reviews:list"]);
    // No personal control renders, and the Reviews section invites a sign-in.
    expect(buttons(tree)).toEqual([]);
    expect(tree.some((host) => host.type === "a" && host.props.href === "/sign-in")).toBe(true);
  });

  it("a visitor whose Clerk session is loading subscribes to none and sees no signed-out prompt", async () => {
    const { releaseId } = await seed();
    harness.auth = AUTH.loading;
    const tree = mount(() => seriesPage(releaseId));
    expect([...harness.subscribed]).toEqual(["reviews:list"]);
    expect(buttons(tree)).toEqual([]);
    expect(tree.some((host) => host.type === "a" && host.props.href === "/sign-in")).toBe(false);
  });

  it("a signed-in reader subscribes to each and gets the controls", async () => {
    const { t, releaseId } = await seed();
    const as = await withUser(t, reader);
    setQuery(api.users.viewer, await as.query(api.users.viewer, {}));
    setQuery(api.ratings.mine, await as.query(api.ratings.mine, { target }));
    setQuery(api.reviews.mine, await as.query(api.reviews.mine, { target }));
    setQuery(api.reviews.hiddenList, await as.query(api.reviews.hiddenList, { target }));
    setQuery(api.follows.seriesFollow, await as.query(api.follows.seriesFollow, { seriesPublicId: 1 }));
    setQuery(api.favorites.isFavorite, await as.query(api.favorites.isFavorite, { target }));
    setQuery(api.sharing.seriesVisibility, await as.query(api.sharing.seriesVisibility, { seriesPublicId: 1 }));
    setQuery(api.reading.seriesTracking, await as.query(api.reading.seriesTracking, { seriesPublicId: 1 }));
    setQuery(api.reading.passForRelease, await as.query(api.reading.passForRelease, { releaseId }));
    setQuery(api.collection.entryForRelease, await as.query(api.collection.entryForRelease, { releaseId }));
    setQuery(api.collection.seriesEntries, await as.query(api.collection.seriesEntries, { seriesPublicId: 1 }));
    const tree = mount(() => seriesPage(releaseId));
    expect([...harness.subscribed].sort()).toEqual([...PERSONAL, "reviews:list"].sort());
    expect(buttons(tree)).toEqual(expect.arrayContaining(["Write a review", "Follow series", "Favorite", "Mark read"]));
    expect(tree.some((host) => host.type === "a" && host.props.href === "/sign-in")).toBe(false);
    expect(pageText(tree)).toContain("Your reading");
  });

  it("a signed-in visitor subscribes at once but is shown nothing until Convex accepts the token", async () => {
    const { releaseId } = await seed();
    harness.convexAuth = { isLoading: true, isAuthenticated: false };
    // What the client may still hold from before the sign-in: anonymous answers.
    for (const name of PERSONAL) harness.snapshot.set(name, null);
    const tree = mount(() => seriesPage(releaseId));
    expect([...harness.subscribed].sort()).toEqual([...PERSONAL, "reviews:list"].sort());
    expect(buttons(tree)).toEqual([]);
    expect(tree.some((host) => host.type === "a" && host.props.href === "/sign-in")).toBe(false);
  });

  it("a signed-in visitor whose token Convex refuses sees the signed-out page", async () => {
    const { releaseId } = await seed();
    harness.convexAuth = { isLoading: false, isAuthenticated: false };
    const tree = mount(() => seriesPage(releaseId));
    expect(buttons(tree)).toEqual([]);
    expect(tree.some((host) => host.type === "a" && host.props.href === "/sign-in")).toBe(true);
  });

  it("without Clerk (no auth provider) the page reads as signed out", async () => {
    const { releaseId } = await seed();
    harness.auth = null;
    const tree = mount(() => seriesPage(releaseId));
    expect([...harness.subscribed]).toEqual(["reviews:list"]);
    expect(tree.some((host) => host.type === "a" && host.props.href === "/sign-in")).toBe(true);
  });

  it("the shelf overlay subscribes to neither of its queries signed out or while loading", () => {
    for (const auth of [AUTH.signedOut, AUTH.loading, null]) {
      resetHarness();
      harness.auth = auth;
      let overlay: ReturnType<typeof useSeriesOverlay> | undefined;
      mount(() => {
        overlay = useSeriesOverlay(1);
        return null;
      });
      expect(overlay).toBeNull();
      expect([...harness.subscribed]).toEqual([]);
    }
  });

  it("the header's viewer is null signed out and while loading, without subscribing", () => {
    for (const auth of [AUTH.signedOut, AUTH.loading]) {
      resetHarness();
      harness.auth = auth;
      let viewer: ReturnType<typeof useReadyViewer> | undefined;
      mount(() => {
        viewer = useReadyViewer();
        return null;
      });
      expect(viewer).toBeNull();
      expect([...harness.subscribed]).toEqual([]);
    }
  });
});

describe("RecordHistory", () => {
  /** Open the rendered disclosure as a click on its summary would. */
  function open(tree: Host[]) {
    const details = tree.find((host) => host.type === "details");
    if (!details) throw new Error("no disclosure");
    const onToggle = details.props.onToggle as (event: { currentTarget: { open: boolean } }) => void;
    onToggle({ currentTarget: { open: true } });
  }
  const history = () => createElement(RecordHistory, { type: "series", publicId: 1 });

  it("subscribes only once opened, loading until the history arrives", async () => {
    const { t } = await seed();
    harness.auth = AUTH.signedOut; // public: auth plays no part
    let tree = mount(history);
    expect(harness.subscribed.has("moderation:recordHistory")).toBe(false);
    expect(tree.some((host) => host.props.className === "record-history-count")).toBe(false);

    open(tree);
    tree = mount(history);
    expect(harness.subscribed.has("moderation:recordHistory")).toBe(true);
    expect(tree.map((host) => text(host.props.children))).toContain("Loading…");

    setQuery(api.moderation.recordHistory, await t.query(api.moderation.recordHistory, { type: "series", publicId: 1 }));
    tree = mount(history);
    expect(tree.map((host) => text(host.props.children))).toContain("No changes recorded yet.");
    expect(text(tree.find((host) => host.props.className === "record-history-count")?.props.children)).toBe(
      "0 revisions",
    );
  });
});
