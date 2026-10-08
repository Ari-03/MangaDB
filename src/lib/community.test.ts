import { describe, expect, it } from "vitest";

import { DISCORD_INVITE_URL, browserLabel, bugReportText } from "./community";

describe("bugReportText", () => {
  const context = {
    page: "/mod/queue?from=imports",
    role: "moderator",
    theme: "dark",
    viewport: "1440×900",
    browser: "Firefox 148 on Linux",
    time: new Date("2026-10-08T14:32:05Z"),
  };

  it("starts with the page and carries the context, then the three questions", () => {
    const text = bugReportText(context);
    expect(text.startsWith("Page: /mod/queue?from=imports\n")).toBe(true);
    expect(text).toContain("Role: moderator · Theme: dark · Viewport: 1440×900");
    expect(text).toContain("When: 2026-10-08 14:32 UTC");
    expect(text).toContain("What happened:");
    expect(text).toContain("What I expected:");
    expect(text).toContain("Steps to reproduce:");
    expect(text).not.toContain("Proposal:");
  });

  it("names the proposal on a proposal page", () => {
    expect(bugReportText({ ...context, page: "/mod/proposal/k57abc?x=1" })).toContain(
      "Proposal: k57abc",
    );
  });
});

describe("browserLabel", () => {
  it("names the most specific browser and the system", () => {
    expect(
      browserLabel("Mozilla/5.0 (X11; Linux x86_64; rv:148.0) Gecko/20100101 Firefox/148.0"),
    ).toBe("Firefox 148 on Linux");
    expect(
      browserLabel(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0",
      ),
    ).toBe("Edge 140 on Windows");
    expect(
      browserLabel(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
      ),
    ).toBe("Safari 18 on iOS");
    expect(browserLabel("")).toBe("unknown browser");
  });
});

it("invites to the MangaDB Discord", () => {
  expect(DISCORD_INVITE_URL).toBe("https://discord.gg/VVcC8a79mz");
});
