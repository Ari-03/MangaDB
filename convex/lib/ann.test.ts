// ANN parser tests (ticket #36) against the live XML shapes captured
// 2026-08-20 from reports.xml / api.xml (Frieren, manga id 24449).

import { describe, expect, it } from "vitest";
import {
  parseAnnDate,
  parseApiResponse,
  parseReport,
  splitReleaseTitle,
} from "./ann";

const REPORT = `<report skipped="0" listed="3"><args><type>manga</type></args>
<item><id>40451</id><gid>2503062384</gid><type>manga</type><name>Soshite Kuchibiru ni Chi ga Nijimu</name><precision>manga</precision><vintage>2026-08-19</vintage></item>
<item><id>40447</id><gid>1853155867</gid><type>manga</type><name>There&#039;s No Freaking Way I&#039;ll Be Your Lover! Unless... Second Season</name><precision>manga</precision><vintage>2027</vintage></item>
<item><id>9999</id><gid>1</gid><type>anime</type><name>Not A Manga</name></item></report>`;

const API = `<ann><manga id="24449" gid="2959400328" type="manga" name="Frieren: Beyond Journey&#039;s End" precision="manga" generated-on="2026-08-20T00:14:41Z">
<info gid="4083496145" type="Main title" lang="EN">Frieren: Beyond Journey&#039;s End</info>
<info gid="3004762124" type="Alternative title" lang="IT">Frieren - Oltre la fine del viaggio</info>
<info gid="1628474890" type="Alternative title" lang="JA">Sōsō no Frieren</info>
<info gid="1173357738" type="Alternative title" lang="JA">葬送のフリーレン</info>
<info gid="2033164419" type="Genres">adventure</info>
<release date="2021-11-09" href="https://www.animenewsnetwork.com/encyclopedia/releases.php?id=42006">Frieren: Beyond Journey&#039;s End (eBook 1)</release>
<release date="2021-11-09" href="https://www.animenewsnetwork.com/encyclopedia/releases.php?id=42005">Frieren: Beyond Journey&#039;s End (GN 1)</release>
<release date="2026-02-10" href="https://www.animenewsnetwork.com/encyclopedia/releases.php?id=52404">Frieren: Beyond Journey&#039;s End (GN 14)</release>
<release date="2024-11-00" href="https://www.animenewsnetwork.com/encyclopedia/releases.php?id=51000">Frieren: Beyond Journey&#039;s End (GN 7.5)</release>
<release date="2025-01-01" href="https://www.animenewsnetwork.com/encyclopedia/releases.php?id=51001">Frieren: Beyond Journey&#039;s End (Omnibus GN 1-3)</release>
<release date="2025-01-01" href="https://www.animenewsnetwork.com/encyclopedia/releases.php?id=51002">Frieren: The Movie (DVD)</release>
<staff gid="161175717"><task>Story</task><person id="208754">Kanehito Yamada</person></staff>
<staff gid="2097634453"><task>Art</task><person id="208753">Tsukasa Abe</person></staff></manga><warning>no result for manga=4658</warning></ann>`;

describe("parseReport", () => {
  it("enumerates manga items, decoding entities and skipping non-manga", () => {
    const items = parseReport(REPORT);
    expect(items.map((i) => i.id)).toEqual(["40451", "40447"]);
    expect(items[1]!.name).toBe(
      "There's No Freaking Way I'll Be Your Lover! Unless... Second Season",
    );
  });
});

describe("parseAnnDate — ANN's month-precision convention", () => {
  it("keeps full, month, and year precision distinct", () => {
    expect(parseAnnDate("2026-02-10")).toEqual({ year: 2026, month: 2, day: 10 });
    expect(parseAnnDate("2024-11-00")).toEqual({ year: 2024, month: 11 });
    expect(parseAnnDate("2027")).toEqual({ year: 2027 });
    expect(parseAnnDate("soon")).toBeUndefined();
  });
});

describe("splitReleaseTitle", () => {
  it("classifies GN/eBook designators and extracts labels", () => {
    expect(splitReleaseTitle("Frieren (GN 14)")).toMatchObject({
      title: "Frieren",
      label: "14",
      format: "physical",
      multi: false,
      editionLineHint: false,
    });
    expect(splitReleaseTitle("Frieren (eBook 2)")).toMatchObject({
      label: "2",
      format: "digital",
    });
    expect(splitReleaseTitle("Frieren (GN 7.5)")).toMatchObject({ label: "7.5" });
    expect(splitReleaseTitle("Oneshot Story (GN)")).toMatchObject({
      label: undefined,
      multi: false,
    });
  });

  it("flags omnibus/box-set packaging and ranges; rejects non-book lines", () => {
    expect(splitReleaseTitle("Frieren (Omnibus GN 1-3)")).toMatchObject({
      multi: true,
      editionLineHint: true,
    });
    expect(splitReleaseTitle("Frieren (Hardcover GN 3)")).toMatchObject({
      label: "3",
      editionLineHint: true,
    });
    expect(splitReleaseTitle("Frieren: The Movie (DVD)")).toBeNull();
    expect(splitReleaseTitle("No designator at all")).toBeNull();
  });
});

describe("parseApiResponse", () => {
  it("parses the manga record: titles, filtered alt titles, staff, releases", () => {
    const records = parseApiResponse(API);
    expect(records).toHaveLength(1);
    const manga = records[0]!;
    expect(manga.id).toBe("24449");
    expect(manga.title).toBe("Frieren: Beyond Journey's End");
    // EN/JA alternative titles only — the Italian one is dropped.
    expect(manga.altTitles).toEqual(["Sōsō no Frieren", "葬送のフリーレン"]);
    expect(manga.staff).toEqual(["Kanehito Yamada", "Tsukasa Abe"]);
    // The DVD line is rejected; five book lines remain.
    expect(manga.releases).toHaveLength(5);
    expect(manga.releases[1]).toMatchObject({
      annId: "42005",
      date: { year: 2021, month: 11, day: 9 },
      label: "1",
      format: "physical",
    });
    expect(manga.releases[3]).toMatchObject({
      annId: "51000",
      date: { year: 2024, month: 11 },
      label: "7.5",
    });
    expect(manga.releases[4]).toMatchObject({ multi: true, editionLineHint: true });
  });

  it("tolerates warnings and empty responses", () => {
    expect(parseApiResponse("<ann><warning>no result</warning></ann>")).toEqual([]);
  });
});
