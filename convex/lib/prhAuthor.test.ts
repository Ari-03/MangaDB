// PRH author-line parser tests: every shape is a real `author` string from
// the 2026-10-01 production export (11,809 PRH snapshots), with how often
// it appeared where the count matters.

import { describe, expect, it } from "vitest";
import { parseAuthorCredits } from "./prh";

/** The parse as "name: role" lines, for compact expectations. */
const credits = (line: string) =>
  parseAuthorCredits(line).map((credit) => `${credit.name}: ${credit.role}`);

describe("parseAuthorCredits", () => {
  it("reads a bare name or a list of names as role-less authors", () => {
    expect(credits("Yui Sakuma")).toEqual(["Yui Sakuma: author"]);
    expect(credits("Kazuo Koike and Goseki Kojima")).toEqual([
      "Kazuo Koike: author",
      "Goseki Kojima: author",
    ]);
    expect(credits("Kazuo Koike, Goseki Kojima")).toEqual([
      "Kazuo Koike: author",
      "Goseki Kojima: author",
    ]);
    // Lowercase pen names are names.
    expect(credits("coolkyousinnjya")).toEqual(["coolkyousinnjya: author"]);
    expect(credits("akabeko")).toEqual(["akabeko: author"]);
    expect(credits("suu Morishita")).toEqual(["suu Morishita: author"]);
  });

  it("maps labelled clauses split by semicolons, commas, or full stops", () => {
    expect(credits("Story by Muneyuki Kaneshiro; Art by Yusuke Nomura")).toEqual([
      "Muneyuki Kaneshiro: story",
      "Yusuke Nomura: art",
    ]);
    expect(
      credits("Story by Iori Miyazawa, Art by Eita Mizuno, Character Design by Shirakaba"),
    ).toEqual(["Iori Miyazawa: story", "Eita Mizuno: art"]);
    expect(
      credits("Original concept by Hajime Isayama; Story by Ryo Suzukaze; Art by Satoshi Shiki"),
    ).toEqual(["Hajime Isayama: original", "Ryo Suzukaze: story", "Satoshi Shiki: art"]);
    expect(
      credits("Written and illustrated by Shin'ichi Sakamoto. Translated by Michael Gombos."),
    ).toEqual(["Shin'ichi Sakamoto: story_art"]);
    expect(credits("Created by Spike Chunsoft. Manga by Karin Suzuragi.")).toEqual([
      "Spike Chunsoft: original",
      "Karin Suzuragi: art",
    ]);
  });

  it("reads combined tasks and drops the ones that make no author", () => {
    expect(credits("Story and Art by NAOE")).toEqual(["NAOE: story_art"]);
    expect(credits("Adaptation and Artwork by Gou Tanabe")).toEqual(["Gou Tanabe: art"]);
    expect(credits("Story & layouts by Hiro Mashima; art by Atsuo Ueda")).toEqual([
      "Hiro Mashima: story",
      "Atsuo Ueda: art",
    ]);
    expect(credits("By Kei Urana; Graffiti designs by Hideyoshi Andou")).toEqual([
      "Kei Urana: author",
    ]);
    // "Original ..." credits the original creators, whatever else it lists.
    expect(
      credits("Original Story and Illustrations by Touya and Yoimachi, Art by Ren Sakuma"),
    ).toEqual(["Touya: original", "Yoimachi: original", "Ren Sakuma: art"]);
  });

  it("splits joined names and drops parenthesised studios", () => {
    expect(
      credits(
        "Story by Shinkoshoto, Art by Liver Jam & POPO (Friendly Land), Character Design by Huuka Kazabana",
      ),
    ).toEqual(["Shinkoshoto: story", "Liver Jam: art", "POPO: art"]);
  });

  it("gives an unlabelled opening name the role the labels leave open", () => {
    expect(credits("Mitsuki Mihara; Illustrated by MonRin")).toEqual([
      "Mitsuki Mihara: story",
      "MonRin: art",
    ]);
    expect(
      credits("Munmun; Illustrated by Butcha-U; Character Designs by Kei Mizuryu"),
    ).toEqual(["Munmun: story", "Butcha-U: art"]);
    expect(credits("Chashiba Katase; Story by Kyo Shirodaira")).toEqual([
      "Chashiba Katase: art",
      "Kyo Shirodaira: story",
    ]);
    expect(credits("Kimitake Yoshioka; created by Kenji Inoue")).toEqual([
      "Kimitake Yoshioka: author",
      "Kenji Inoue: original",
    ]);
    expect(credits("Osamu Tezuka; Story & Art by Satoshi Shiki")).toEqual([
      "Osamu Tezuka: original",
      "Satoshi Shiki: story_art",
    ]);
  });

  it("makes a writer nobody draws for the role-less author", () => {
    expect(credits("Written by Yasuhiro Nightow")).toEqual(["Yasuhiro Nightow: author"]);
  });

  it("refuses shapes it does not recognise", () => {
    // Last, First: which word is the family name is a guess.
    expect(credits("Fushimi, Tsukasa")).toEqual([]);
    expect(credits("LeGrow, M. Alice")).toEqual([]);
    expect(credits("Leebora, Lanyong; Illustrated by Ocean")).toEqual([]);
    // Not names, or labels in a form this does not read.
    expect(credits("Osamu Tezuka, Various Artists")).toEqual([]);
    expect(credits("Oku, Hiroya: creator, writer, illustrator")).toEqual([]);
    expect(credits("Reiji Miyajima with additional art by Yuka Kinami")).toEqual([]);
    expect(credits("Character designs by POP; Shun Kazakami")).toEqual([]);
    expect(
      credits("Series Creators Steven Moffat & Mark Gatiss; Written by Steven Moffat with art by Jay"),
    ).toEqual([]);
    expect(credits("")).toEqual([]);
    expect(parseAuthorCredits(undefined)).toEqual([]);
  });
});
