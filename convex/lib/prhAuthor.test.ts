// PRH author-line parser tests: every shape is a real `author` string from
// the 2026-10-01 production export (11,809 PRH snapshots), with how often
// it appeared where the count matters.

import { describe, expect, it } from "vitest";
import { isPersonName, parseAuthorCredits } from "./prh";

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
    // A long name is fine beside labels: "Mo Xiang Tong Xiu" is one pen name.
    expect(credits("Mo Xiang Tong Xiu; Illustrated by Luo Di Cheng Qiu")).toEqual([
      "Mo Xiang Tong Xiu: story",
      "Luo Di Cheng Qiu: art",
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
    expect(credits("Written by Kazuo Koike. Illustrated by Goseki Kojima.")).toEqual([
      "Kazuo Koike: story",
      "Goseki Kojima: art",
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
    expect(credits("Original Story by Toshio Satou, Art by Hajime Fusemachi")).toEqual([
      "Toshio Satou: original",
      "Hajime Fusemachi: art",
    ]);
    // A mixed "Original ..." label can't say who wrote and who illustrated.
    expect(
      credits(
        "Original Story and Illustrations by Mayo Momoyo and Itsuki Mito, Art by Kaki Nagato",
      ),
    ).toEqual(["Kaki Nagato: art"]);
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
    expect(credits("Munmun; Illustrated by Butcha-U; Character Designs by Kei Mizuryu")).toEqual([
      "Munmun: story",
      "Butcha-U: art",
    ]);
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

  it("credits nobody for several unlabelled names beside a story or art label", () => {
    // Co-writers or original creators: the line doesn't say.
    expect(
      credits("Ken Ishikawa, Eiichi Shimizu, and Go Nagai; Illustrated by Tomohiro Shimoguchi"),
    ).toEqual(["Tomohiro Shimoguchi: art"]);
    // With no story or art label they are the authors, as on a bare line.
    expect(
      credits("Manatsu Suzuki and Yoshihiro Sono; Original concept by Mitsuki Nakamura"),
    ).toEqual(["Manatsu Suzuki: author", "Yoshihiro Sono: author", "Mitsuki Nakamura: original"]);
  });

  it("leaves organisations out, keeping the people", () => {
    expect(credits("MiHoYo Comics")).toEqual([]);
    expect(credits("Manta Comics")).toEqual([]);
    // SNK's label still says someone else drew it, so Azuma is the artist.
    expect(credits("SNK Corporation; Illustrated by Kyoutarou Azuma")).toEqual([
      "Kyoutarou Azuma: art",
    ]);
    expect(credits("Jupiter Studio; Illustrated by kaltoma; Character Designs by Yunagi")).toEqual([
      "kaltoma: art",
    ]);
    expect(credits("Go Nagai; Illustrated by Team Moon")).toEqual(["Go Nagai: story"]);
    expect(credits("Created by Spike Chunsoft. Manga by Karin Suzuragi.")).toEqual([
      "Karin Suzuragi: art",
    ]);
    expect(credits("Manga by Shiramine; created by TYPE-MOON")).toEqual(["Shiramine: art"]);
    expect(credits("TOKYOPOP")).toEqual([]);
    expect(credits("Hololive")).toEqual([]);
    expect(credits("Story by Koma Warita; Art by Riku Tsuchida; Created by ZAG")).toEqual([
      "Koma Warita: story",
      "Riku Tsuchida: art",
    ]);
    expect(credits("Subaru Nitou; Original Work by NTT Solmare")).toEqual(["Subaru Nitou: author"]);
    expect(credits("Ryo Kamito; Original Story by Liar Soft")).toEqual(["Ryo Kamito: author"]);
  });

  it("names the creator of an adapted work its original creator", () => {
    // As in the "Story & Art by" and "Created by" variants of the same line.
    expect(credits("Osamu Tezuka; Adapted and Illustrated by Satoshi Shiki")).toEqual([
      "Osamu Tezuka: original",
      "Satoshi Shiki: art",
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
    expect(credits("Asumiko Nakamura, Ema Toyama, Banko Kuze, et al.")).toEqual([]);
    // Two people run into one name.
    expect(credits("Jin x Sayuki (ZOWLS); Illustrated by Sayuki")).toEqual([]);
    expect(credits("Kazuo Koike Goseki Kojima")).toEqual([]);
    expect(
      credits(
        "Series Creators Steven Moffat & Mark Gatiss; Written by Steven Moffat with art by Jay",
      ),
    ).toEqual([]);
    expect(credits("")).toEqual([]);
    expect(parseAuthorCredits(undefined)).toEqual([]);
  });
});

describe("isPersonName", () => {
  it("passes people and stops organisations in a creator list", () => {
    expect(isPersonName("Akane Shimizu")).toBe(true);
    expect(isPersonName("CLAMP")).toBe(true);
    for (const name of ["Various", "Atlus", "BONES", "616th Special Information Battalion"]) {
      expect(isPersonName(name)).toBe(false);
    }
  });
});
