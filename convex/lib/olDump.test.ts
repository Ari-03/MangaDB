import { describe, expect, it } from "vitest";
import { dumpFormatEvidence, statedFormatLine } from "../test.olDumpFormats";
import { dayStart, editionsDump, olDateTime, readDumpLine, sha256Hex } from "./olDump";

const subtle = async (text: string) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
const lines = dumpFormatEvidence.map(({ reviewed }) => {
  if (reviewed.ol.kind !== "olDumpEditionPhysicalFormatAbsent") throw new Error("Dump fixture.");
  return reviewed.ol;
});

describe("synchronous SHA-256", () => {
  it("agrees with WebCrypto across block boundaries, UTF-8 and the retained dump lines", async () => {
    const inputs = [
      "",
      "abc",
      ...[55, 56, 57, 63, 64, 65, 119, 120, 128].map((n) => "x".repeat(n)),
      "Skip·Beat! ガチャ 🎴",
      "y".repeat(20_000),
      statedFormatLine,
      ...lines.map((ol) => ol.line),
    ];
    for (const text of inputs) expect(sha256Hex(text)).toBe(await subtle(text));
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    for (const ol of lines) expect(sha256Hex(ol.line)).toBe(ol.lineSha256);
  });
});

describe("reading one monthly dump line", () => {
  it("keeps the raw edition JSON beside the deployed parser's snapshot", () => {
    const [shield] = lines;
    const facts = readDumpLine(shield!.line);
    if (typeof facts === "string") throw new Error(facts);
    expect(facts).toMatchObject({
      type: "/type/edition",
      key: "/books/OL35953803M",
      revision: "1",
      lastModified: "2021-12-27T06:58:15.927625",
      snapshot: { key: "/books/OL35953803M", subtitle: "The Manga Companion", format: "physical" },
    });
    expect(Object.hasOwn(facts.edition, "physical_format")).toBe(false);
    // The parser defaults to physical; the raw field tells absence from a statement.
    const stated = readDumpLine(statedFormatLine);
    if (typeof stated === "string") throw new Error(stated);
    expect(stated.edition.physical_format).toBe("Paperback");
  });
  it("refuses a malformed envelope, JSON or identity, and a line with its terminator", () => {
    const line = lines[0]!.line;
    const columns = line.split("\t");
    expect(readDumpLine(columns.slice(0, 4).join("\t"))).toMatch(/five tab-separated/);
    expect(readDumpLine([...columns.slice(0, 4), "{not json"].join("\t"))).toMatch(/not JSON/);
    expect(readDumpLine([...columns.slice(0, 4), "[]"].join("\t"))).toMatch(/not an object/);
    expect(readDumpLine([columns[0], "/books/OL1M", ...columns.slice(2)].join("\t"))).toMatch(
      /identity disagrees/,
    );
    expect(readDumpLine(`${line}\n`)).toMatch(/without its terminator/);
  });
});

describe("dump dates", () => {
  it("names the official dated file and reads only real days and OL datetimes", () => {
    expect(editionsDump("2026-09-30")).toEqual({
      file: "ol_dump_editions_2026-09-30.txt.gz",
      url: "https://archive.org/download/ol_dump_2026-09-30/ol_dump_editions_2026-09-30.txt.gz",
    });
    expect(dayStart("2026-09-30")).toBe(Date.UTC(2026, 8, 30));
    for (const bad of ["2026-02-30", "2026-9-30", "latest", ""]) expect(dayStart(bad)).toBeNull();
    expect(olDateTime("2021-12-27T06:58:15.927625")).toBe(Date.UTC(2021, 11, 27, 6, 58, 15));
    for (const bad of ["2021-12-27", "2021-12-27T24:00:00", "2021-12-27T06:58:15Z"])
      expect(olDateTime(bad)).toBeNull();
  });
});
