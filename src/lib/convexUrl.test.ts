// The one place that decides the Convex URL. Under vitest `import.meta.env`
// reads `process.env`, so one stub sets both sources, and the browser case
// (no `process`, only the value Vite inlined at build time) cannot be run.

import { afterEach, describe, expect, it, vi } from "vitest";

import { convexUrl } from "./convexUrl";

const DEPLOYMENT = "https://fake-deployment-123.convex.invalid";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("convexUrl", () => {
  it("returns VITE_CONVEX_URL when it is set", () => {
    vi.stubEnv("VITE_CONVEX_URL", DEPLOYMENT);
    expect(convexUrl()).toBe(DEPLOYMENT);
  });

  it("throws a message naming the variable and the setup step when it is absent", () => {
    vi.stubEnv("VITE_CONVEX_URL", undefined);
    expect(() => convexUrl()).toThrow(
      /^VITE_CONVEX_URL is not set\. Locally, run `npx convex dev`.*README/,
    );
  });

  it("treats an empty value as absent", () => {
    vi.stubEnv("VITE_CONVEX_URL", "");
    expect(() => convexUrl()).toThrow("VITE_CONVEX_URL is not set");
  });
});
