// Captured R4 identity-other source snapshots and canonical declarations, 2026-10-06.
// Graph IDs are remapped in tests. Alias readiness does not claim new publisher research.
import type { OlEditionSnapshot } from "./lib/openLibrary";
import type { Overrides } from "./test.factories";

export const nonAnnAliasCases = [
  {
    source: {
      format: "physical",
      isbn13: "9781421587233",
      key: "/books/OL29314952M",
      kind: "olEdition",
      multiVolume: false,
      publishDate: {
        year: 2017,
      },
      publishers: ["Viz Media"],
      seriesTitle: "7thGARDEN",
      title: "7thGARDEN, Vol. 3",
      url: "https://openlibrary.org/books/OL29314952M",
      volumeLabel: "3",
    },
    lastSeenAt: 1791122515047,
    heldAt: 1791114228458,
    holdKind: "isbn",
    series: {
      title: "7th Garden",
      altTitles: ["セブンスガーデン", "7thGARDEN"],
    },
    heldSeries: null,
    publisher: {
      name: "VIZ Media",
      slug: "viz-media",
    },
    volumes: [
      {
        label: "3",
      },
    ],
    release: {
      isbn13: "9781421587233",
      isbn10: "1421587238",
      format: "physical",
      language: "en",
    },
    ready: true,
  },
  {
    source: {
      format: "physical",
      isbn13: "9781421590691",
      key: "/books/OL28610219M",
      kind: "olEdition",
      multiVolume: false,
      publishDate: {
        year: 2017,
      },
      publishers: ["Viz Media"],
      seriesTitle: "Terra Formars",
      title: "Terra Formars",
      url: "https://openlibrary.org/books/OL28610219M",
    },
    lastSeenAt: 1791119196445,
    heldAt: 1791111601155,
    holdKind: "isbn",
    series: {
      title: "Terraformars",
      altTitles: ["Terra Formars", "テラフォーマーズ"],
    },
    heldSeries: null,
    publisher: {
      name: "VIZ Media",
      slug: "viz-media",
    },
    volumes: [
      {
        label: "16",
      },
    ],
    release: {
      isbn13: "9781421590691",
      isbn10: "1421590697",
      format: "physical",
      language: "en",
    },
    ready: true,
  },
  {
    source: {
      format: "physical",
      isbn13: "9781974743520",
      key: "/books/OL51095317M",
      kind: "olEdition",
      multiVolume: false,
      publishDate: {
        year: 2024,
      },
      publishers: ["Viz Media"],
      seriesTitle: "Marriage Toxin",
      title: "Marriage Toxin, Vol. 1",
      url: "https://openlibrary.org/books/OL51095317M",
      volumeLabel: "1",
    },
    lastSeenAt: 1791119679581,
    heldAt: 1791111994561,
    holdKind: "isbn",
    series: {
      title: "MARRIAGETOXIN",
      altTitles: ["Marriage Toxin", "マリッジトキシン"],
    },
    heldSeries: null,
    publisher: {
      name: "VIZ Media",
      slug: "viz-media",
    },
    volumes: [
      {
        label: "1",
      },
    ],
    release: {
      isbn13: "9781974743520",
      isbn10: "1974743527",
      format: "physical",
      language: "en",
    },
    ready: true,
  },
  {
    source: {
      format: "physical",
      isbn13: "9781401220525",
      key: "/books/OL25979221M",
      kind: "olEdition",
      multiVolume: false,
      publishDate: {
        year: 2010,
      },
      publishers: ["CMX"],
      seriesTitle: "Stolen Hearts",
      title: "Stolen Hearts",
      url: "https://openlibrary.org/books/OL25979221M",
    },
    lastSeenAt: 1791141732253,
    heldAt: 1791115927036,
    holdKind: "isbn",
    series: {
      title: "Toraware Gokko",
      altTitles: ["Stolen Hearts", "とらわれごっこ"],
    },
    heldSeries: null,
    publisher: {
      name: "CMX",
      slug: "cmx",
    },
    volumes: [
      {
        label: "2",
      },
    ],
    release: {
      isbn13: "9781401220525",
      isbn10: "1401220525",
      format: "physical",
      language: "en",
    },
    ready: true,
  },
  {
    source: {
      description:
        "The demon Sessho-Maru is back for vengeance, but with stronger powers at his disposal. Will Inuyasha be able to defeat him again? Then, the demon Naraku is on the attack again, but Kaede's memories of the past may give Inuyasha the edge he needs in the coming showdown.",
      format: "physical",
      isbn10: "1591161142",
      isbn13: "9781591161141",
      key: "/books/OL22996836M",
      kind: "olEdition",
      multiVolume: false,
      publishDate: {
        year: 2003,
      },
      publishers: ["Viz Communications"],
      seriesTitle: "Inu-Yasha",
      title: "Inu-Yasha, Vol. 7",
      url: "https://openlibrary.org/books/OL22996836M",
      volumeLabel: "7",
    },
    lastSeenAt: 1791146946804,
    heldAt: 1791120659788,
    holdKind: "isbn",
    series: {
      title: "Inuyasha",
      altTitles: [
        "Inu-Yasha",
        "Inu-Yasha: A Feudal Fairy Tale",
        "Sengoku Otogi Zōshi InuYasha",
        "Sengoku Otogi Zoushi InuYasha",
        "Sengoku otogizóši Inujaša",
        "犬夜叉",
      ],
    },
    heldSeries: null,
    publisher: {
      name: "VIZ Media",
      slug: "viz-media",
    },
    volumes: [
      {
        label: "7",
      },
    ],
    release: {
      isbn13: "9781591161141",
      isbn10: "1591161142",
      format: "physical",
      language: "en",
    },
    ready: true,
  },
  {
    source: {
      format: "physical",
      isbn13: "9781642731446",
      key: "/books/OL34150290M",
      kind: "olEdition",
      multiVolume: false,
      publishDate: {
        year: 2021,
      },
      publishers: ["One Peace Books, Incorporated"],
      seriesTitle: "Higehiro",
      title: "Higehiro Volume 1",
      url: "https://openlibrary.org/books/OL34150290M",
      volumeLabel: "1",
    },
    lastSeenAt: 1791145086139,
    heldAt: 1791118934557,
    holdKind: "isbn",
    series: {
      title: "Hige o Soru. Soshite Joshi Kōsei o Hirō.",
      altTitles: [
        "Higehiro",
        "Higehiro: After Being Rejected, I Shaved and Took in a High School Runaway",
        "ひげを剃る。そして女子高生を拾う。",
      ],
    },
    heldSeries: null,
    publisher: {
      name: "One Peace Books",
      slug: "one-peace-books",
    },
    volumes: [
      {
        label: "1",
      },
    ],
    release: {
      isbn13: "9781642731446",
      isbn10: "1642731447",
      format: "physical",
      language: "en",
    },
    ready: true,
  },
  {
    source: {
      format: "physical",
      isbn10: "159532139X",
      isbn13: "9781595321398",
      key: "/books/OL24943773M",
      kind: "olEdition",
      multiVolume: false,
      publishDate: {
        year: 2004,
      },
      publishers: ["Tokyopop"],
      seriesTitle: "Tramps like us",
      title: "Tramps like us",
      url: "https://openlibrary.org/books/OL24943773M",
    },
    lastSeenAt: 1791124630314,
    heldAt: 1791115061574,
    holdKind: "isbn",
    series: {
      title: "You're My Pet",
      altTitles: ["Kimi wa Pet", "My Pet Momo", "Tramps Like Us", "You're a Pet", "きみはペット"],
    },
    heldSeries: null,
    publisher: {
      name: "Tokyopop",
      slug: "tokyopop",
    },
    volumes: [
      {
        label: "1",
      },
    ],
    release: {
      isbn13: "9781595321398",
      isbn10: "159532139X",
      format: "physical",
      language: "en",
    },
    ready: true,
  },
  {
    source: {
      description:
        "Fumi is glad Akira is back in her life. Even in kindergarten, Akira knew how to stand up for herself, and she was always willing to stand up for Fumi too. But Fumi's first love recently got married, and Fumi is grappling with a broken heart and the fact that her sweetheart was another woman.",
      format: "physical",
      isbn10: "1421592983",
      isbn13: "9781421592985",
      key: "/books/OL26934110M",
      kind: "olEdition",
      multiVolume: false,
      publishDate: {
        year: 2017,
      },
      publishers: ["Viz Media"],
      seriesTitle: "Sweet Blue Flowers",
      title: "Sweet Blue Flowers, Volume 1",
      url: "https://openlibrary.org/books/OL26934110M",
      volumeLabel: "1",
    },
    lastSeenAt: 1791142216980,
    heldAt: 1791116323265,
    holdKind: "volumeMissing",
    series: {
      title: "Aoi Hana",
      altTitles: ["Sweet Blue Flowers", "青い花"],
    },
    heldSeries: null,
    publisher: {
      name: "VIZ Media",
      slug: "viz-media",
    },
    volumes: [
      {
        label: "1",
      },
      {
        label: "2",
      },
    ],
    release: {
      isbn13: "9781421592985",
      isbn10: "1421592983",
      format: "physical",
      language: "en",
    },
    ready: false,
  },
  {
    source: {
      bareSplit: {
        seriesTitle: "Lone Wolf and Cub",
        volumeLabel: "8",
      },
      binding: "paperback",
      format: "physical",
      isbn10: "1569715092",
      isbn13: "9781569715093",
      key: "/books/OL8694071M",
      kind: "olEdition",
      multiVolume: false,
      publishDate: {
        day: 25,
        month: 4,
        year: 2001,
      },
      publishers: ["Dark Horse"],
      seriesTitle: "Lone Wolf and Cub 8: Chains of Death",
      title: "Lone Wolf and Cub 8: Chains of Death",
      url: "https://openlibrary.org/books/OL8694071M",
    },
    lastSeenAt: 1791120461846,
    heldAt: 1791115368632,
    holdKind: "isbn",
    series: {
      title: "Lone Wolf and Cub",
      altTitles: [],
    },
    heldSeries: null,
    publisher: {
      name: "Dark Horse",
      slug: "dark-horse",
    },
    volumes: [
      {
        label: "8",
      },
    ],
    release: {
      isbn13: "9781569715093",
      isbn10: "1569715092",
      format: "physical",
      language: "en",
    },
    ready: false,
  },
  {
    source: {
      binding: "paperback",
      format: "physical",
      isbn10: "1591828589",
      isbn13: "9781591828587",
      key: "/books/OL8858004M",
      kind: "olEdition",
      multiVolume: false,
      publishDate: {
        day: 3,
        month: 8,
        year: 2004,
      },
      publishers: ["TokyoPop"],
      seriesTitle: "Seikai Trilogy",
      title: "Seikai Trilogy",
      url: "https://openlibrary.org/books/OL8858004M",
    },
    lastSeenAt: 1791150112080,
    heldAt: 1791123119099,
    holdKind: "isbn",
    series: {
      title: "Crest of the Stars",
      altTitles: ["Seikai no Monshō", "The Seikai Trilogy", "星界の紋章"],
    },
    heldSeries: null,
    publisher: {
      name: "Tokyopop",
      slug: "tokyopop",
    },
    volumes: [
      {
        label: "2",
      },
    ],
    release: {
      isbn13: "9781591828587",
      isbn10: "1591828589",
      format: "physical",
      language: "en",
    },
    ready: false,
  },
  {
    source: {
      format: "physical",
      isbn10: "1932234888",
      isbn13: "9781932234886",
      key: "/books/OL25271664M",
      kind: "olEdition",
      multiVolume: false,
      publishDate: {
        year: 2012,
      },
      publishers: ["Vertical"],
      seriesTitle: "GTO, Great Teacher Onizuka",
      title: "GTO, Great Teacher Onizuka, Volume 1",
      url: "https://openlibrary.org/books/OL25271664M",
      volumeLabel: "1",
    },
    lastSeenAt: 1791146887561,
    heldAt: 1791120609052,
    holdKind: "isbn",
    series: {
      title: "GTO: 14 Days in Shonan",
      altTitles: ["Great Teacher Onizuka: Shonan 14 Days", "GTO: Shonan 14 Days"],
    },
    heldSeries: {
      title: "GTO: Great Teacher Onizuka",
      altTitles: ["GTO", "Great Teacher Onizuka"],
    },
    publisher: {
      name: "Vertical",
      slug: "vertical",
    },
    volumes: [
      {
        label: "1",
      },
    ],
    release: {
      isbn13: "9781932234886",
      isbn10: "1932234888",
      format: "physical",
      binding: "paperback",
      language: "en",
    },
    ready: false,
  },
] satisfies Array<{
  source: OlEditionSnapshot;
  lastSeenAt: number;
  heldAt: number;
  holdKind: "isbn" | "series" | "packaging" | "volumeMissing";
  series: Overrides<"series">;
  heldSeries: Overrides<"series"> | null;
  publisher: Overrides<"publishers">;
  volumes: Array<Pick<Overrides<"volumes">, "label" | "position">>;
  release: Pick<Overrides<"releases">, "isbn13" | "isbn10" | "format" | "binding" | "language">;
  ready: boolean;
}>;
