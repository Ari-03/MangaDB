import { describe, expect, it } from "vitest";

import { canonicalRedirect } from "./canonicalHost";

const HOST = "mangadb.org";
const get = (url: string) => new Request(url);

describe("canonicalRedirect", () => {
  it("301s www to the apex, preserving path and query", () => {
    const res = canonicalRedirect(
      get("https://www.mangadb.org/releases/2026-08?format=physical"),
      HOST,
    );
    expect(res?.status).toBe(301);
    expect(res?.headers.get("location")).toBe(
      "https://mangadb.org/releases/2026-08?format=physical",
    );
  });

  it("301s http to https on the apex", () => {
    const res = canonicalRedirect(get("http://mangadb.org/series/1/foo"), HOST);
    expect(res?.status).toBe(301);
    expect(res?.headers.get("location")).toBe("https://mangadb.org/series/1/foo");
  });

  it("collapses http+www into a single hop", () => {
    const res = canonicalRedirect(get("http://www.mangadb.org/"), HOST);
    expect(res?.headers.get("location")).toBe("https://mangadb.org/");
  });

  it("leaves canonical https requests alone", () => {
    expect(canonicalRedirect(get("https://mangadb.org/"), HOST)).toBeNull();
  });

  it("leaves non-canonical hosts (workers.dev previews, localhost) alone", () => {
    expect(
      canonicalRedirect(get("https://mangadb.someone.workers.dev/"), HOST),
    ).toBeNull();
    expect(canonicalRedirect(get("http://localhost:3000/"), HOST)).toBeNull();
  });

  it("does nothing when no canonical host is configured", () => {
    expect(
      canonicalRedirect(get("https://www.mangadb.org/"), undefined),
    ).toBeNull();
    expect(canonicalRedirect(get("https://www.mangadb.org/"), "")).toBeNull();
  });
});
