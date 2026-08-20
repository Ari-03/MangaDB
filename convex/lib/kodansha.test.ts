// Kodansha parser tests (ticket #36) against the live wire shapes captured
// 2026-08-20 from kodansha.us/wp-json/kodansha/v1/*.

import { describe, expect, it } from "vitest";
import {
  parseCalendar,
  parseCreators,
  parseIsoDate,
  parseNewReleases,
  parseVolumeLabel,
  parseVolumeUrl,
  sourceRecordId,
  toSnapshots,
} from "./kodansha";

// Verbatim slices of the live payloads (including the   in titles).
const CALENDAR = {
  success: true,
  data: [
    {
      tue_key: "2026-08-04",
      date_label: "Published on Aug. 4, 2026",
      is_past: true,
      items: [
        {
          title: "Volume 21",
          series_name: "Welcome to Demon School! Iruma-kun",
          creators: "By Osamu Nishi",
          image: "https://production.image.azuki.co/b80d2b33/800.webp",
          volume_url:
            "https://kodansha.us/series/welcome-to-demon-school-iruma-kun/volume-21/",
          formats: ["digital", "print"],
        },
        {
          title: "Volume 22",
          series_name: "Tying the Knot with an Amagami Sister",
          creators: "By Marcey Naito",
          image: "https://production.image.azuki.co/ea90e88b/800.webp",
          volume_url:
            "https://kodansha.us/series/tying-the-knot-with-an-amagami-sister/volume-22/",
          formats: ["digital"],
        },
        { title: "malformed", volume_url: 42 },
      ],
    },
  ],
};

const NEW_RELEASES = {
  success: true,
  data: [
    {
      series_name: "My Home Hero",
      volume_title: "Volume 26",
      image: "https://production.image.azuki.co/99becf61/800.webp",
      volume_url: "https://kodansha.us/series/my-home-hero/volume-26/",
      series_slug: "my-home-hero",
      series_type: "comic",
      creators: "By Naoki Yamakawa, Masashi Asaki",
      release_date: "2026-08-18T04:00:00+00:00",
      product_uuid: "e6e2286a",
      volume_uuid: "991d2c15",
      age_rating: 18,
      is_purchasable: true,
      has_print: false,
      is_free: false,
    },
    {
      series_name: "Some Light Novel",
      volume_title: "Volume 3",
      volume_url: "https://kodansha.us/series/some-light-novel/volume-3/",
      series_type: "novel",
      release_date: "2026-08-18T04:00:00+00:00",
      is_purchasable: true,
      has_print: true,
    },
  ],
};

describe("small parsers", () => {
  it("splits volume URLs into slugs", () => {
    expect(
      parseVolumeUrl("https://kodansha.us/series/my-home-hero/volume-26/"),
    ).toEqual({ seriesSlug: "my-home-hero", volumeSlug: "volume-26" });
    expect(parseVolumeUrl("https://kodansha.us/about/")).toBeNull();
  });

  it("reads volume labels through the API's non-breaking space", () => {
    expect(parseVolumeLabel("Volume 21")).toBe("21");
    expect(parseVolumeLabel("Volume 7.5")).toBe("7.5");
    expect(parseVolumeLabel("Box Set")).toBeUndefined();
  });

  it("splits creator bylines", () => {
    expect(parseCreators("By Naoki Yamakawa, Masashi Asaki")).toEqual([
      "Naoki Yamakawa",
      "Masashi Asaki",
    ]);
    expect(parseCreators(undefined)).toEqual([]);
  });

  it("parses both ISO date shapes", () => {
    expect(parseIsoDate("2026-08-04")).toEqual({ year: 2026, month: 8, day: 4 });
    expect(parseIsoDate("2026-08-18T04:00:00+00:00")).toEqual({
      year: 2026,
      month: 8,
      day: 18,
    });
    expect(parseIsoDate("soon")).toBeUndefined();
  });
});

describe("parseCalendar", () => {
  it("flattens weekly buckets, dating items by tue_key and skipping malformed ones", () => {
    const items = parseCalendar(CALENDAR);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      seriesTitle: "Welcome to Demon School! Iruma-kun",
      seriesSlug: "welcome-to-demon-school-iruma-kun",
      volumeSlug: "volume-21",
      volumeLabel: "21",
      creators: ["Osamu Nishi"],
      formats: ["physical", "digital"],
      releaseDate: { year: 2026, month: 8, day: 4 },
    });
    expect(items[1]!.formats).toEqual(["digital"]);
  });
});

describe("parseNewReleases", () => {
  it("keeps comics with per-format flags and drops novels", () => {
    const items = parseNewReleases(NEW_RELEASES);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      seriesTitle: "My Home Hero",
      volumeLabel: "26",
      formats: ["digital"], // has_print false, is_purchasable true
      releaseDate: { year: 2026, month: 8, day: 18 },
    });
  });
});

describe("per-format snapshots", () => {
  it("splits one item into one snapshot per format with distinct identities", () => {
    const item = parseCalendar(CALENDAR)[0]!;
    const snapshots = toSnapshots(item);
    expect(snapshots.map((s) => s.format)).toEqual(["physical", "digital"]);
    expect(sourceRecordId(item, "physical")).toBe(
      "welcome-to-demon-school-iruma-kun/volume-21#physical",
    );
    expect(sourceRecordId(item, "digital")).not.toBe(
      sourceRecordId(item, "physical"),
    );
    expect(snapshots[0]!.title).toBe(
      "Welcome to Demon School! Iruma-kun Volume 21",
    );
  });
});
