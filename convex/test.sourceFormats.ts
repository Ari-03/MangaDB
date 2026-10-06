import type { OlEditionSnapshot } from "./lib/openLibrary";

// Saved public OL bodies and exact publisher sections, captured 2026-10-06.
// Source: source-format-guard-plan-r1 and format-slot-evidence-r1 review artifacts.
// No live IDs; graph dependencies are remapped by the workflow factory.
export const sourceFormatEvidence = [
  {
    wire: '{"type": {"key": "/type/edition"}, "authors": [{"key": "/authors/OL7912289A"}, {"key": "/authors/OL3865823A"}, {"key": "/authors/OL7833737A"}], "isbn_13": ["9781952241581"], "languages": [{"key": "/languages/eng"}], "publish_date": "2023", "publishers": ["Kaiten Books LLC"], "source_records": ["bwb:9781952241581"], "subjects": ["Comics & graphic novels, general", "Fiction, fantasy, general"], "title": "Loner Life in Another World Vol. 9 (manga)", "full_title": "Loner Life in Another World Vol. 9 (manga)", "works": [{"key": "/works/OL35764085W"}], "key": "/books/OL48256628M", "latest_revision": 1, "revision": 1, "created": {"type": "/type/datetime", "value": "2023-06-17T11:29:02.202291"}, "last_modified": {"type": "/type/datetime", "value": "2023-06-17T11:29:02.202291"}}',
    frozen:
      '{"format":"physical","isbn13":"9781952241581","key":"/books/OL48256628M","kind":"olEdition","multiVolume":false,"publishDate":{"year":2023},"publishers":["Kaiten Books LLC"],"seriesTitle":"Loner Life in Another World","title":"Loner Life in Another World Vol. 9 (manga)","url":"https://openlibrary.org/books/OL48256628M","volumeLabel":"9"}',
    reviewed: {
      kind: "olInferredPhysicalToDigital",
      sourceKey: "openlibrary",
      to: "digital",
      key: "/books/OL48256628M",
      isbn13: "9781952241581",
      baseSnapshot:
        '{"format":"physical","isbn13":"9781952241581","key":"/books/OL48256628M","kind":"olEdition","multiVolume":false,"publishDate":{"year":2023},"publishers":["Kaiten Books LLC"],"seriesTitle":"Loner Life in Another World","title":"Loner Life in Another World Vol. 9 (manga)","url":"https://openlibrary.org/books/OL48256628M","volumeLabel":"9"}',
      reason: "Publisher own ISBN ebook section and exact OL missing physical_format reviewed.",
      publisher: {
        kind: "publisherOwnIsbnEbook",
        isbn13: "9781952241581",
        url: "https://www.kaitenbooks.com/loner-life-9",
        fetchedAt: 1791302738572,
        bodySha256: "f9fbead0ad5c97863cab0a6d86ca3b83acf9b5ccd603e6513c0aeb13b5ed58ed",
        sectionSha256: "9b178a06aa269da9c6ecab1b1507e4063b55251107a37a29c724ca521b07f633",
        byteStart: 188232,
        byteEndExclusive: 188262,
        excerpt: "ISBN: 978-1-952241-58-1(ebook)",
      },
      ol: {
        kind: "olPhysicalFormatAbsent",
        key: "/books/OL48256628M",
        isbn13: "9781952241581",
        url: "https://openlibrary.org/books/OL48256628M.json",
        fetchedAt: 1791303477546,
        bodySha256: "9822e4251e65ace139565d57135412ef592cb2ce33955000fe241ac5dd6bf10f",
        physicalFormatAbsent: true,
        normalizedSnapshot:
          '{"format":"physical","isbn13":"9781952241581","key":"/books/OL48256628M","kind":"olEdition","multiVolume":false,"publishDate":{"year":2023},"publishers":["Kaiten Books LLC"],"seriesTitle":"Loner Life in Another World","title":"Loner Life in Another World Vol. 9 (manga)","url":"https://openlibrary.org/books/OL48256628M","volumeLabel":"9"}',
      },
      from: "physical",
    },
  },
  {
    wire: '{"type": {"key": "/type/edition"}, "authors": [{"key": "/authors/OL10042523A"}, {"key": "/authors/OL7538570A"}], "isbn_13": ["9781952241505"], "languages": [{"key": "/languages/eng"}], "publish_date": "2023", "publishers": ["Kaiten Books LLC"], "source_records": ["bwb:9781952241505"], "subjects": ["Comics & graphic novels, general", "Fiction, general"], "title": "Yakuza\'s Guide to Babysitting Vol. 6", "full_title": "Yakuza\'s Guide to Babysitting Vol. 6", "works": [{"key": "/works/OL34054517W"}], "key": "/books/OL46116962M", "latest_revision": 1, "revision": 1, "created": {"type": "/type/datetime", "value": "2023-01-17T09:38:58.414561"}, "last_modified": {"type": "/type/datetime", "value": "2023-01-17T09:38:58.414561"}}',
    frozen:
      '{"format":"physical","isbn13":"9781952241505","key":"/books/OL46116962M","kind":"olEdition","multiVolume":false,"publishDate":{"year":2023},"publishers":["Kaiten Books LLC"],"seriesTitle":"Yakuza\'s Guide to Babysitting","title":"Yakuza\'s Guide to Babysitting Vol. 6","url":"https://openlibrary.org/books/OL46116962M","volumeLabel":"6"}',
    reviewed: {
      kind: "olInferredPhysicalToDigital",
      sourceKey: "openlibrary",
      to: "digital",
      key: "/books/OL46116962M",
      isbn13: "9781952241505",
      baseSnapshot:
        '{"format":"physical","isbn13":"9781952241505","key":"/books/OL46116962M","kind":"olEdition","multiVolume":false,"publishDate":{"year":2023},"publishers":["Kaiten Books LLC"],"seriesTitle":"Yakuza\'s Guide to Babysitting","title":"Yakuza\'s Guide to Babysitting Vol. 6","url":"https://openlibrary.org/books/OL46116962M","volumeLabel":"6"}',
      reason: "Publisher own ISBN ebook section and exact OL missing physical_format reviewed.",
      publisher: {
        kind: "publisherOwnIsbnEbook",
        isbn13: "9781952241505",
        url: "https://www.kaitenbooks.com/yakuza-babysitter-6",
        fetchedAt: 1791302738573,
        bodySha256: "1e7c83aa1a5cab4f40dc1435375726a0b0c68d51bc177b2fb4b7508887fffe90",
        sectionSha256: "2d91a410f8a1b9723577904c058a26c5779c9f1a2b30dc7cae5d747eec59a6e5",
        byteStart: 185206,
        byteEndExclusive: 185237,
        excerpt: "ISBN: 978-1-952241-50-5 (ebook)",
      },
      ol: {
        kind: "olPhysicalFormatAbsent",
        key: "/books/OL46116962M",
        isbn13: "9781952241505",
        url: "https://openlibrary.org/books/OL46116962M.json",
        fetchedAt: 1791303477547,
        bodySha256: "404b0c287fd184b16946ab6543e8c8edd7017f22083b8d21a6d108b204279bc0",
        physicalFormatAbsent: true,
        normalizedSnapshot:
          '{"format":"physical","isbn13":"9781952241505","key":"/books/OL46116962M","kind":"olEdition","multiVolume":false,"publishDate":{"year":2023},"publishers":["Kaiten Books LLC"],"seriesTitle":"Yakuza\'s Guide to Babysitting","title":"Yakuza\'s Guide to Babysitting Vol. 6","url":"https://openlibrary.org/books/OL46116962M","volumeLabel":"6"}',
      },
      from: "physical",
    },
  },
  {
    wire: '{"type": {"key": "/type/edition"}, "authors": [{"key": "/authors/OL10042523A"}, {"key": "/authors/OL7538570A"}], "isbn_13": ["9781952241666"], "languages": [{"key": "/languages/eng"}], "publish_date": "2024", "publishers": ["Kaiten Books LLC"], "source_records": ["bwb:9781952241666"], "subjects": ["Comics & graphic novels, general"], "title": "Yakuza\'s Guide to Babysitting Vol. 7", "full_title": "Yakuza\'s Guide to Babysitting Vol. 7", "works": [{"key": "/works/OL37762674W"}], "key": "/books/OL50959711M", "latest_revision": 1, "revision": 1, "created": {"type": "/type/datetime", "value": "2024-02-01T05:06:14.526475"}, "last_modified": {"type": "/type/datetime", "value": "2024-02-01T05:06:14.526475"}}',
    frozen:
      '{"format":"physical","isbn13":"9781952241666","key":"/books/OL50959711M","kind":"olEdition","multiVolume":false,"publishDate":{"year":2024},"publishers":["Kaiten Books LLC"],"seriesTitle":"Yakuza\'s Guide to Babysitting","title":"Yakuza\'s Guide to Babysitting Vol. 7","url":"https://openlibrary.org/books/OL50959711M","volumeLabel":"7"}',
    reviewed: {
      kind: "olInferredPhysicalToDigital",
      sourceKey: "openlibrary",
      to: "digital",
      key: "/books/OL50959711M",
      isbn13: "9781952241666",
      baseSnapshot:
        '{"format":"physical","isbn13":"9781952241666","key":"/books/OL50959711M","kind":"olEdition","multiVolume":false,"publishDate":{"year":2024},"publishers":["Kaiten Books LLC"],"seriesTitle":"Yakuza\'s Guide to Babysitting","title":"Yakuza\'s Guide to Babysitting Vol. 7","url":"https://openlibrary.org/books/OL50959711M","volumeLabel":"7"}',
      reason: "Publisher own ISBN ebook section and exact OL missing physical_format reviewed.",
      publisher: {
        kind: "publisherOwnIsbnEbook",
        isbn13: "9781952241666",
        url: "https://www.kaitenbooks.com/yakuza-babysitter-7",
        fetchedAt: 1791302738572,
        bodySha256: "dc6350912bed3df158d4c8332d840e213fe90ee771dfb2da5fbc9492bb8bd811",
        sectionSha256: "851d953c4f0f4b5a0f549838b3f3fb9bf0fd5b46371f5e27bcc873d9845bbcdd",
        byteStart: 185477,
        byteEndExclusive: 185508,
        excerpt: "ISBN: 978-1-952241-66-6 (ebook)",
      },
      ol: {
        kind: "olPhysicalFormatAbsent",
        key: "/books/OL50959711M",
        isbn13: "9781952241666",
        url: "https://openlibrary.org/books/OL50959711M.json",
        fetchedAt: 1791303477547,
        bodySha256: "6b628cb6b1f75053966647e419869b60e18e637f7f4565037fd99fdac8c1eb74",
        physicalFormatAbsent: true,
        normalizedSnapshot:
          '{"format":"physical","isbn13":"9781952241666","key":"/books/OL50959711M","kind":"olEdition","multiVolume":false,"publishDate":{"year":2024},"publishers":["Kaiten Books LLC"],"seriesTitle":"Yakuza\'s Guide to Babysitting","title":"Yakuza\'s Guide to Babysitting Vol. 7","url":"https://openlibrary.org/books/OL50959711M","volumeLabel":"7"}',
      },
      from: "physical",
    },
  },
  {
    wire: '{"type": {"key": "/type/edition"}, "authors": [{"key": "/authors/OL9869234A"}, {"key": "/authors/OL9869232A"}, {"key": "/authors/OL10042522A"}], "isbn_13": ["9781952241680"], "languages": [{"key": "/languages/eng"}], "publish_date": "2024", "publishers": ["Kaiten Books LLC"], "source_records": ["bwb:9781952241680"], "subjects": ["Comics & graphic novels, general", "Fiction, fantasy, general"], "title": "Gacha Girls Corps Vol. 6 (manga)", "works": [{"key": "/works/OL37759712W"}], "key": "/books/OL50952255M", "latest_revision": 1, "revision": 1, "created": {"type": "/type/datetime", "value": "2024-02-01T03:39:44.236754"}, "last_modified": {"type": "/type/datetime", "value": "2024-02-01T03:39:44.236754"}}',
    frozen:
      '{"format":"physical","isbn13":"9781952241680","key":"/books/OL50952255M","kind":"olEdition","multiVolume":false,"publishDate":{"year":2024},"publishers":["Kaiten Books LLC"],"seriesTitle":"Gacha Girls Corps","title":"Gacha Girls Corps Vol. 6 (manga)","url":"https://openlibrary.org/books/OL50952255M","volumeLabel":"6"}',
    reviewed: {
      kind: "olInferredPhysicalToDigital",
      sourceKey: "openlibrary",
      to: "digital",
      key: "/books/OL50952255M",
      isbn13: "9781952241680",
      baseSnapshot:
        '{"format":"physical","isbn13":"9781952241680","key":"/books/OL50952255M","kind":"olEdition","multiVolume":false,"publishDate":{"year":2024},"publishers":["Kaiten Books LLC"],"seriesTitle":"Gacha Girls Corps","title":"Gacha Girls Corps Vol. 6 (manga)","url":"https://openlibrary.org/books/OL50952255M","volumeLabel":"6"}',
      reason: "Publisher own ISBN ebook section and exact OL missing physical_format reviewed.",
      publisher: {
        kind: "publisherOwnIsbnEbook",
        isbn13: "9781952241680",
        url: "https://www.kaitenbooks.com/gacha-girls-corps-6",
        fetchedAt: 1791302703134,
        bodySha256: "58d98d7938f0db0a7e759930f1d38be5d679b7299b2364260e9098406b103b50",
        sectionSha256: "e957aa95a4477d457e870d10aa0843062713020333d89ff4b93486a8ea0df592",
        byteStart: 189478,
        byteEndExclusive: 189509,
        excerpt: "ISBN: 978-1-952241-68-0 (ebook)",
      },
      ol: {
        kind: "olPhysicalFormatAbsent",
        key: "/books/OL50952255M",
        isbn13: "9781952241680",
        url: "https://openlibrary.org/books/OL50952255M.json",
        fetchedAt: 1791303477547,
        bodySha256: "0ae1486b49b1750327601fa7e980cfa1abcc4987b2c33cbd0f89ad4cbb89cf08",
        physicalFormatAbsent: true,
        normalizedSnapshot:
          '{"format":"physical","isbn13":"9781952241680","key":"/books/OL50952255M","kind":"olEdition","multiVolume":false,"publishDate":{"year":2024},"publishers":["Kaiten Books LLC"],"seriesTitle":"Gacha Girls Corps","title":"Gacha Girls Corps Vol. 6 (manga)","url":"https://openlibrary.org/books/OL50952255M","volumeLabel":"6"}',
      },
      from: "physical",
    },
  },
  {
    wire: '{"type": {"key": "/type/edition"}, "authors": [{"key": "/authors/OL9869234A"}, {"key": "/authors/OL9869232A"}, {"key": "/authors/OL10042522A"}], "isbn_13": ["9781952241567"], "languages": [{"key": "/languages/eng"}], "publish_date": "2023", "publishers": ["Kaiten Books LLC"], "source_records": ["bwb:9781952241567"], "subjects": ["Comics & graphic novels, general", "Fiction, fantasy, general"], "title": "Gacha Girls Corps Vol. 5 (manga)", "works": [{"key": "/works/OL35758938W"}], "key": "/books/OL48249506M", "latest_revision": 1, "revision": 1, "created": {"type": "/type/datetime", "value": "2023-06-17T11:08:32.739572"}, "last_modified": {"type": "/type/datetime", "value": "2023-06-17T11:08:32.739572"}}',
    frozen:
      '{"format":"physical","isbn13":"9781952241567","key":"/books/OL48249506M","kind":"olEdition","multiVolume":false,"publishDate":{"year":2023},"publishers":["Kaiten Books LLC"],"seriesTitle":"Gacha Girls Corps","title":"Gacha Girls Corps Vol. 5 (manga)","url":"https://openlibrary.org/books/OL48249506M","volumeLabel":"5"}',
    reviewed: {
      kind: "olInferredPhysicalToDigital",
      sourceKey: "openlibrary",
      to: "digital",
      key: "/books/OL48249506M",
      isbn13: "9781952241567",
      baseSnapshot:
        '{"format":"physical","isbn13":"9781952241567","key":"/books/OL48249506M","kind":"olEdition","multiVolume":false,"publishDate":{"year":2023},"publishers":["Kaiten Books LLC"],"seriesTitle":"Gacha Girls Corps","title":"Gacha Girls Corps Vol. 5 (manga)","url":"https://openlibrary.org/books/OL48249506M","volumeLabel":"5"}',
      reason: "Publisher own ISBN ebook section and exact OL missing physical_format reviewed.",
      publisher: {
        kind: "publisherOwnIsbnEbook",
        isbn13: "9781952241567",
        url: "https://www.kaitenbooks.com/gacha-girls-corps-5",
        fetchedAt: 1791302703134,
        bodySha256: "c45a9f4263b7024db743949b647e09ab4b5bae2bac0989dc9731437e00d3b65e",
        sectionSha256: "c0b247a6a4b5aa43f3ae82bb993f3f1d2f55114b0a39d308ede9a58f76cccb76",
        byteStart: 189494,
        byteEndExclusive: 189525,
        excerpt: "ISBN: 978-1-952241-56-7 (ebook)",
      },
      ol: {
        kind: "olPhysicalFormatAbsent",
        key: "/books/OL48249506M",
        isbn13: "9781952241567",
        url: "https://openlibrary.org/books/OL48249506M.json",
        fetchedAt: 1791303477548,
        bodySha256: "f8f91509ebf97e2eccbf309f3b6d8bbad506babefce1c8145337295abd35989f",
        physicalFormatAbsent: true,
        normalizedSnapshot:
          '{"format":"physical","isbn13":"9781952241567","key":"/books/OL48249506M","kind":"olEdition","multiVolume":false,"publishDate":{"year":2023},"publishers":["Kaiten Books LLC"],"seriesTitle":"Gacha Girls Corps","title":"Gacha Girls Corps Vol. 5 (manga)","url":"https://openlibrary.org/books/OL48249506M","volumeLabel":"5"}',
      },
      from: "physical",
    },
  },
  // Kaiten's own line separates the ISBN from "(ebook)" with a literal &nbsp;.
  {
    wire: '{"type": {"key": "/type/edition"}, "authors": [{"key": "/authors/OL10042523A"}, {"key": "/authors/OL7538570A"}], "isbn_13": ["9781952241161"], "languages": [{"key": "/languages/eng"}], "publish_date": "2021", "publishers": ["Kaiten Books LLC"], "source_records": ["bwb:9781952241161"], "subjects": ["Comics & graphic novels, general", "Fiction, general"], "title": "Yakuza\'s Guide to Babysitting Vol. 1", "full_title": "Yakuza\'s Guide to Babysitting Vol. 1", "works": [{"key": "/works/OL36455222W"}], "key": "/books/OL62317151M", "latest_revision": 1, "revision": 1, "created": {"type": "/type/datetime", "value": "2026-07-17T00:56:18.943373"}, "last_modified": {"type": "/type/datetime", "value": "2026-07-17T00:56:18.943373"}}',
    frozen:
      '{"format":"physical","isbn13":"9781952241161","key":"/books/OL62317151M","kind":"olEdition","multiVolume":false,"publishDate":{"year":2021},"publishers":["Kaiten Books LLC"],"seriesTitle":"Yakuza\'s Guide to Babysitting","title":"Yakuza\'s Guide to Babysitting Vol. 1","url":"https://openlibrary.org/books/OL62317151M","volumeLabel":"1"}',
    reviewed: {
      kind: "olInferredPhysicalToDigital",
      sourceKey: "openlibrary",
      from: "physical",
      to: "digital",
      key: "/books/OL62317151M",
      isbn13: "9781952241161",
      baseSnapshot:
        '{"format":"physical","isbn13":"9781952241161","key":"/books/OL62317151M","kind":"olEdition","multiVolume":false,"publishDate":{"year":2021},"publishers":["Kaiten Books LLC"],"seriesTitle":"Yakuza\'s Guide to Babysitting","title":"Yakuza\'s Guide to Babysitting Vol. 1","url":"https://openlibrary.org/books/OL62317151M","volumeLabel":"1"}',
      reason: "Publisher own ISBN ebook section and exact OL missing physical_format reviewed.",
      publisher: {
        kind: "publisherOwnIsbnEbook",
        isbn13: "9781952241161",
        url: "https://www.kaitenbooks.com/yakuza-babysitter-1",
        fetchedAt: 1791322457341,
        bodySha256: "ece0112469487ae1197512c5df90f353b8b21fc16d2f645a8dceaf03a96f83af",
        sectionSha256: "d56954e450966df2dd60f88ad149b6d3b8cdcb2a28597bde1ff2616740c5c33d",
        byteStart: 190815,
        byteEndExclusive: 190851,
        excerpt: "ISBN: 978-1-952241-16-1&nbsp;(ebook)",
      },
      ol: {
        kind: "olPhysicalFormatAbsent",
        key: "/books/OL62317151M",
        isbn13: "9781952241161",
        url: "https://openlibrary.org/books/OL62317151M.json",
        fetchedAt: 1791322266142,
        bodySha256: "032dae121a3a6dae8382ab58c734588f4d3343a00898016293e7345a7346cffe",
        physicalFormatAbsent: true,
        normalizedSnapshot:
          '{"format":"physical","isbn13":"9781952241161","key":"/books/OL62317151M","kind":"olEdition","multiVolume":false,"publishDate":{"year":2021},"publishers":["Kaiten Books LLC"],"seriesTitle":"Yakuza\'s Guide to Babysitting","title":"Yakuza\'s Guide to Babysitting Vol. 1","url":"https://openlibrary.org/books/OL62317151M","volumeLabel":"1"}',
      },
    },
  },
] as const;
export const gachaPhysicalGraph = {
  publisher: {
    name: "Kaiten Books",
    slug: "kaiten-books",
    status: "active",
  },
  series: {
    publicId: 1837,
    title: "Gacha Girls Corps",
    altTitles: [
      "Gacha o Mawashite Nakama o Fuyasu: Saikyō no Bishōjo Gundan o Tsukuriagero",
      "ガチャを回して仲間を増やす 最強の美少女軍団を作り上げろ THE COMIC",
    ],
    searchText:
      "Gacha Girls Corps Gacha o Mawashite Nakama o Fuyasu: Saikyō no Bishōjo Gundan o Tsukuriagero ガチャを回して仲間を増やす 最強の美少女軍団を作り上げろ THE COMIC ggc gomnofsnbgot gomnof snbgot ガ最tc gachagirlscorps gachaomawashitenakamaofuyasusaikyonobishojogundanotsukuriagero gachaomawashitenakamaofuyasu saikyonobishojogundanotsukuriagero ガチャを回して仲間を増やす最強の美少女軍団を作り上げろthecomic",
    status: "active",
  },
  volume: {
    publicId: 32366,
    label: "5",
    status: "active",
  },
  edition: {
    publicId: 33883,
    status: "active",
  },
  release: {
    isbn13: "9781952241574",
    format: "physical",
    language: "en",
    status: "active",
    pubDate: {
      sort: 20230000,
      year: 2023,
    },
  },
  sourceLastSeenAt: 1791141397494.0,
  holdReason: 'Series 1837 ("Gacha Girls Corps") has no Volume 5; Kaiten Books publishes it.',
} as const;
// One Peace manga ebooks proven by a primary digital distributor's own SKU:
// BookWalker JSON-LD Product and BreadcrumbList, or OverDrive's mediaItems
// object, captured 2026-10-06 with full bodies retained
// (one-peace-distributor-proof); OL bodies captured the same day. Spear Hero
// and Healing Magic bases carry the OL subtitle these bodies parse to.
export const distributorFormatEvidence = [
  {
    wire: '{"type": {"key": "/type/edition"}, "authors": [{"key": "/authors/OL7867863A"}, {"key": "/authors/OL7909088A"}, {"key": "/authors/OL7622364A"}], "isbn_13": ["9781642731842"], "languages": [{"key": "/languages/eng"}], "publish_date": "2022", "publishers": ["One Peace Books, Incorporated"], "source_records": ["bwb:9781642731842"], "subjects": ["Comics & graphic novels, general"], "title": "Reprise of the Spear Hero Volume 07", "subtitle": "The Manga Companion", "full_title": "Reprise of the Spear Hero Volume 07 The Manga Companion", "works": [{"key": "/works/OL26004669W"}], "key": "/books/OL36098365M", "latest_revision": 1, "revision": 1, "created": {"type": "/type/datetime", "value": "2021-12-28T09:13:54.862714"}, "last_modified": {"type": "/type/datetime", "value": "2021-12-28T09:13:54.862714"}}',
    frozen:
      '{"format":"physical","isbn13":"9781642731842","key":"/books/OL36098365M","kind":"olEdition","multiVolume":false,"publishDate":{"year":2022},"publishers":["One Peace Books, Incorporated"],"seriesTitle":"Reprise of the Spear Hero","subtitle":"The Manga Companion","title":"Reprise of the Spear Hero Volume 07","url":"https://openlibrary.org/books/OL36098365M","volumeLabel":"7"}',
    reviewed: {
      kind: "olInferredPhysicalToDigital",
      sourceKey: "openlibrary",
      from: "physical",
      to: "digital",
      key: "/books/OL36098365M",
      isbn13: "9781642731842",
      baseSnapshot:
        '{"format":"physical","isbn13":"9781642731842","key":"/books/OL36098365M","kind":"olEdition","multiVolume":false,"publishDate":{"year":2022},"publishers":["One Peace Books, Incorporated"],"seriesTitle":"Reprise of the Spear Hero","subtitle":"The Manga Companion","title":"Reprise of the Spear Hero Volume 07","url":"https://openlibrary.org/books/OL36098365M","volumeLabel":"7"}',
      reason:
        "Primary digital distributor's own SKU metadata and exact OL missing physical_format reviewed.",
      publisher: {
        kind: "primaryDigitalDistributorOwnSku",
        distributor: "bookwalker",
        isbn13: "9781642731842",
        sku: "3DMCJWXC24B0",
        url: "https://bookwalker.com/volume/3DMCJWXC24B0/the-reprise-of-the-spear-hero-volume-7",
        httpStatus: 200,
        fetchedAt: 1791322588317,
        bodySha256: "987b94ebb619403e18e4ce0d387ae6d74fe492bfa7986bb4a581071c8e514033",
        bodyBytes: 359299,
        product: {
          sectionSha256: "754585d7c20f254c26d69bbbfe5911c6a6fc88a326cd8c603742d74b53512db4",
          byteStart: 202924,
          byteEndExclusive: 205304,
          excerpt:
            '{"@context":"https://schema.org","@type":["Product","Book"],"@id":"https://bookwalker.com/volume/3DMCJWXC24B0","name":"The Reprise of the Spear Hero Volume 7","url":"https://bookwalker.com/volume/3DMCJWXC24B0/the-reprise-of-the-spear-hero-volume-7","inLanguage":"en","description":"The loop resets\\" and the journey begins anew! Will Motoyasu and company finally see a different outcome?! After Naofumi and his friends buy Keel from a slave trader and start peddling Keel is determined to transform into a therianthrope so that Motoyasu can understand her but isn\'t having much luck. But when they journey to Siltvelt \\" a panda therianthrope agrees to teach her! What will become of this encounter?!","image":"https://img.sos-dan.net/1200/01K/G/A/EV78S3TWJENYD2C2NSBZA.webp","bookFormat":"https://schema.org/EBook","isbn":"9781642731842","author":{"@type":"Person","name":"Aneko Yusagi"},"brand":{"@type":"Brand","name":"One Peace Books"},"datePublished":"2022-02-26T08:00:00.000Z","potentialAction":{"@type":"ReadAction","target":{"@type":"EntryPoint","urlTemplate":"https://bookwalker.com/volume/3DMCJWXC24B0/the-reprise-of-the-spear-hero-volume-7","actionPlatform":["https://schema.org/DesktopWebPlatform","https://schema.org/AndroidPlatform","https://schema.org/IOSPlatform"]},"expectsAcceptanceOf":{"@type":"Offer","category":"purchase","price":9.99,"priceCurrency":"USD"}},"offers":{"@type":"Offer","url":"https://bookwalker.com/volume/3DMCJWXC24B0/the-reprise-of-the-spear-hero-volume-7","price":9.99,"priceCurrency":"USD","availability":"https://schema.org/InStock","itemCondition":"https://schema.org/NewCondition","seller":{"@type":"Organization","name":"BookWalker","logo":"https://bookwalker.com/icons/icon-512x512.png","url":"https://bookwalker.com/","sameAs":"https://twitter.com/BOOKWALKER_GL"},"hasMerchantReturnPolicy":{"@type":"MerchantReturnPolicy","applicableCountry":"US","returnPolicyCategory":"https://schema.org/MerchantReturnNotPermitted"},"shippingDetails":{"@type":"OfferShippingDetails","shippingRate":{"@type":"MonetaryAmount","value":0,"currency":"USD"},"deliveryTime":{"@type":"ShippingDeliveryTime","handlingTime":{"@type":"QuantitativeValue","minValue":0,"maxValue":0,"unitCode":"DAY"},"transitTime":{"@type":"QuantitativeValue","minValue":0,"maxValue":0,"unitCode":"DAY"}},"shippingDestination":{"@type":"DefinedRegion","addressCountry":"US"}}}}',
        },
        breadcrumbs: {
          sectionSha256: "370858973b0a2f7445ad9f065e2a0d95e4342f6a8ecf4ba7a01f1126aa48e666",
          byteStart: 202438,
          byteEndExclusive: 202880,
          excerpt:
            '{"@context":"https://schema.org","@type":"BreadcrumbList","itemListElement":[{"@type":"ListItem","position":1,"name":"BookWalker","item":"https://bookwalker.com/"},{"@type":"ListItem","position":2,"name":"Manga","item":"https://bookwalker.com/browse?formats%5B%5D=1"},{"@type":"ListItem","position":3,"name":"The Reprise of the Spear Hero Volume 7","item":"https://bookwalker.com/volume/3DMCJWXC24B0/the-reprise-of-the-spear-hero-volume-7"}]}',
        },
      },
      ol: {
        kind: "olPhysicalFormatAbsent",
        key: "/books/OL36098365M",
        isbn13: "9781642731842",
        url: "https://openlibrary.org/books/OL36098365M.json",
        fetchedAt: 1791323270446,
        bodySha256: "5f34f37b52e51ec24f0980d9e7f49d164eaffd593c9b91ba6a415176ebc254a4",
        physicalFormatAbsent: true,
        normalizedSnapshot:
          '{"format":"physical","isbn13":"9781642731842","key":"/books/OL36098365M","kind":"olEdition","multiVolume":false,"publishDate":{"year":2022},"publishers":["One Peace Books, Incorporated"],"seriesTitle":"Reprise of the Spear Hero","subtitle":"The Manga Companion","title":"Reprise of the Spear Hero Volume 07","url":"https://openlibrary.org/books/OL36098365M","volumeLabel":"7"}',
      },
    },
  },
  {
    wire: '{"type": {"key": "/type/edition"}, "authors": [{"key": "/authors/OL7794220A"}], "isbn_13": ["9781642732092"], "languages": [{"key": "/languages/eng"}], "publish_date": "2022", "publishers": ["One Peace Books, Incorporated"], "source_records": ["bwb:9781642732092"], "subjects": ["Comics & graphic novels, general"], "title": "Hinamatsuri Volume 15", "full_title": "Hinamatsuri Volume 15", "works": [{"key": "/works/OL26004673W"}], "key": "/books/OL38061944M", "latest_revision": 1, "revision": 1, "created": {"type": "/type/datetime", "value": "2022-05-26T10:07:48.256839"}, "last_modified": {"type": "/type/datetime", "value": "2022-05-26T10:07:48.256839"}}',
    frozen:
      '{"format":"physical","isbn13":"9781642732092","key":"/books/OL38061944M","kind":"olEdition","multiVolume":false,"publishDate":{"year":2022},"publishers":["One Peace Books, Incorporated"],"seriesTitle":"Hinamatsuri","title":"Hinamatsuri Volume 15","url":"https://openlibrary.org/books/OL38061944M","volumeLabel":"15"}',
    reviewed: {
      kind: "olInferredPhysicalToDigital",
      sourceKey: "openlibrary",
      from: "physical",
      to: "digital",
      key: "/books/OL38061944M",
      isbn13: "9781642732092",
      baseSnapshot:
        '{"format":"physical","isbn13":"9781642732092","key":"/books/OL38061944M","kind":"olEdition","multiVolume":false,"publishDate":{"year":2022},"publishers":["One Peace Books, Incorporated"],"seriesTitle":"Hinamatsuri","title":"Hinamatsuri Volume 15","url":"https://openlibrary.org/books/OL38061944M","volumeLabel":"15"}',
      reason:
        "Primary digital distributor's own SKU metadata and exact OL missing physical_format reviewed.",
      publisher: {
        kind: "primaryDigitalDistributorOwnSku",
        distributor: "bookwalker",
        isbn13: "9781642732092",
        sku: "2N00T2YZWPF0",
        url: "https://bookwalker.com/volume/2N00T2YZWPF0/hinamatsuri-volume-15",
        httpStatus: 200,
        fetchedAt: 1791322588318,
        bodySha256: "e942dd830b106690201ad30dd13e4bb7cb35c6de8d7b5ad9bb02586d8af8ef9a",
        bodyBytes: 342792,
        product: {
          sectionSha256: "b00d7cbecf1089e2acc5f57df4c0fd1bb6196711dc302abdda5dcf60f6c26894",
          byteStart: 202145,
          byteEndExclusive: 204433,
          excerpt:
            '{"@context":"https://schema.org","@type":["Product","Book"],"@id":"https://bookwalker.com/volume/2N00T2YZWPF0","name":"Hinamatsuri Volume 15","url":"https://bookwalker.com/volume/2N00T2YZWPF0/hinamatsuri-volume-15","inLanguage":"en","description":"When Haru was sent back in time by his mysterious future government, he was given one order: Make Rockllusion a reality. Now that he\'s located and assembled all the relevant individuals, he\'s ready to reveal the impact that the fusion of music and illusion is set to have on our world. Brace yourself for the shocking origin story of Hina and her psychokinetic pals in volume 15 of Hinamatsuri!","image":"https://img.sos-dan.net/1200/01K/G/A/G1ZH9MZ6B44AP6K17BWJV.webp","bookFormat":"https://schema.org/EBook","isbn":"9781642732092","author":{"@type":"Person","name":"Masao Ohtake"},"brand":{"@type":"Brand","name":"One Peace Books"},"datePublished":"2022-05-24T07:00:00.000Z","potentialAction":{"@type":"ReadAction","target":{"@type":"EntryPoint","urlTemplate":"https://bookwalker.com/volume/2N00T2YZWPF0/hinamatsuri-volume-15","actionPlatform":["https://schema.org/DesktopWebPlatform","https://schema.org/AndroidPlatform","https://schema.org/IOSPlatform"]},"expectsAcceptanceOf":{"@type":"Offer","category":"purchase","price":9.99,"priceCurrency":"USD"}},"offers":{"@type":"Offer","url":"https://bookwalker.com/volume/2N00T2YZWPF0/hinamatsuri-volume-15","price":9.99,"priceCurrency":"USD","availability":"https://schema.org/InStock","itemCondition":"https://schema.org/NewCondition","seller":{"@type":"Organization","name":"BookWalker","logo":"https://bookwalker.com/icons/icon-512x512.png","url":"https://bookwalker.com/","sameAs":"https://twitter.com/BOOKWALKER_GL"},"hasMerchantReturnPolicy":{"@type":"MerchantReturnPolicy","applicableCountry":"US","returnPolicyCategory":"https://schema.org/MerchantReturnNotPermitted"},"shippingDetails":{"@type":"OfferShippingDetails","shippingRate":{"@type":"MonetaryAmount","value":0,"currency":"USD"},"deliveryTime":{"@type":"ShippingDeliveryTime","handlingTime":{"@type":"QuantitativeValue","minValue":0,"maxValue":0,"unitCode":"DAY"},"transitTime":{"@type":"QuantitativeValue","minValue":0,"maxValue":0,"unitCode":"DAY"}},"shippingDestination":{"@type":"DefinedRegion","addressCountry":"US"}}}}',
        },
        breadcrumbs: {
          sectionSha256: "c86e22f7aef7bc86d200fec703073db61d868523198c153a5a6a9bcebcc1fce8",
          byteStart: 201693,
          byteEndExclusive: 202101,
          excerpt:
            '{"@context":"https://schema.org","@type":"BreadcrumbList","itemListElement":[{"@type":"ListItem","position":1,"name":"BookWalker","item":"https://bookwalker.com/"},{"@type":"ListItem","position":2,"name":"Manga","item":"https://bookwalker.com/browse?formats%5B%5D=1"},{"@type":"ListItem","position":3,"name":"Hinamatsuri Volume 15","item":"https://bookwalker.com/volume/2N00T2YZWPF0/hinamatsuri-volume-15"}]}',
        },
      },
      ol: {
        kind: "olPhysicalFormatAbsent",
        key: "/books/OL38061944M",
        isbn13: "9781642732092",
        url: "https://openlibrary.org/books/OL38061944M.json",
        fetchedAt: 1791323270601,
        bodySha256: "3065d0ffd891b7781f92a4271571367a26a36521f17b9530cbb18239c1f30788",
        physicalFormatAbsent: true,
        normalizedSnapshot:
          '{"format":"physical","isbn13":"9781642732092","key":"/books/OL38061944M","kind":"olEdition","multiVolume":false,"publishDate":{"year":2022},"publishers":["One Peace Books, Incorporated"],"seriesTitle":"Hinamatsuri","title":"Hinamatsuri Volume 15","url":"https://openlibrary.org/books/OL38061944M","volumeLabel":"15"}',
      },
    },
  },
  {
    wire: '{"type": {"key": "/type/edition"}, "authors": [{"key": "/authors/OL9960906A"}, {"key": "/authors/OL10375367A"}], "isbn_13": ["9781642732542"], "languages": [{"key": "/languages/eng"}], "publish_date": "2022", "publishers": ["One Peace Books, Incorporated"], "source_records": ["bwb:9781642732542"], "subjects": ["Comics & graphic novels, general"], "title": "Wrong Way to Use Healing Magic Volume 1", "subtitle": "The Manga Companion", "full_title": "Wrong Way to Use Healing Magic Volume 1 The Manga Companion", "works": [{"key": "/works/OL27806359W"}], "key": "/books/OL39774743M", "latest_revision": 1, "revision": 1, "created": {"type": "/type/datetime", "value": "2022-09-19T12:27:15.831526"}, "last_modified": {"type": "/type/datetime", "value": "2022-09-19T12:27:15.831526"}}',
    frozen:
      '{"format":"physical","isbn13":"9781642732542","key":"/books/OL39774743M","kind":"olEdition","multiVolume":false,"publishDate":{"year":2022},"publishers":["One Peace Books, Incorporated"],"seriesTitle":"Wrong Way to Use Healing Magic","subtitle":"The Manga Companion","title":"Wrong Way to Use Healing Magic Volume 1","url":"https://openlibrary.org/books/OL39774743M","volumeLabel":"1"}',
    reviewed: {
      kind: "olInferredPhysicalToDigital",
      sourceKey: "openlibrary",
      from: "physical",
      to: "digital",
      key: "/books/OL39774743M",
      isbn13: "9781642732542",
      baseSnapshot:
        '{"format":"physical","isbn13":"9781642732542","key":"/books/OL39774743M","kind":"olEdition","multiVolume":false,"publishDate":{"year":2022},"publishers":["One Peace Books, Incorporated"],"seriesTitle":"Wrong Way to Use Healing Magic","subtitle":"The Manga Companion","title":"Wrong Way to Use Healing Magic Volume 1","url":"https://openlibrary.org/books/OL39774743M","volumeLabel":"1"}',
      reason:
        "Primary digital distributor's own SKU metadata and exact OL missing physical_format reviewed.",
      publisher: {
        kind: "primaryDigitalDistributorOwnSku",
        distributor: "bookwalker",
        isbn13: "9781642732542",
        sku: "3R3F9SSTNYT0",
        url: "https://bookwalker.com/volume/3R3F9SSTNYT0/the-wrong-way-to-use-healing-magic-volume-1",
        httpStatus: 200,
        fetchedAt: 1791322609470,
        bodySha256: "6367a69a9e066e622f6044ea5492f0099b6a037426dd1d6092848c77c676cf7d",
        bodyBytes: 352437,
        product: {
          sectionSha256: "f781eed22fe0c86332c6848397b987159037dd86bc3658c17bdb57afbb1af6fe",
          byteStart: 201471,
          byteEndExclusive: 204077,
          excerpt:
            '{"@context":"https://schema.org","@type":["Product","Book"],"@id":"https://bookwalker.com/volume/3R3F9SSTNYT0","name":"The Wrong Way to Use Healing Magic Volume 1","url":"https://bookwalker.com/volume/3R3F9SSTNYT0/the-wrong-way-to-use-healing-magic-volume-1","inLanguage":"en","description":"Usato, an ordinary high schooler, happens to run into two fellow students after school one rainy day. Suddenly, all three of them are engulfed in a magic circle and transported to a fantasy world. There\'s just one tiny problem—Usato is simply dragged along by accident! On top of that, Usato learns that he is capable of using healing magic—an incredibly rare affinity in this new world. Now Usato must spend his days with the rescue team thugs, struggling through their hellish training regimen—learning the wrong way to use healing magic. Get ready for an eccentric otherworld fantasy filled with comedy and combat!","image":"https://img.sos-dan.net/1200/01K/G/9/KMJ9Z5F7B0X0ZZY75RNJV.webp","bookFormat":"https://schema.org/EBook","isbn":"9781642732542","author":{"@type":"Person","name":"Kugayama Reki"},"brand":{"@type":"Brand","name":"One Peace Books"},"datePublished":"2023-01-25T08:00:00.000Z","potentialAction":{"@type":"ReadAction","target":{"@type":"EntryPoint","urlTemplate":"https://bookwalker.com/volume/3R3F9SSTNYT0/the-wrong-way-to-use-healing-magic-volume-1","actionPlatform":["https://schema.org/DesktopWebPlatform","https://schema.org/AndroidPlatform","https://schema.org/IOSPlatform"]},"expectsAcceptanceOf":{"@type":"Offer","category":"purchase","price":9.99,"priceCurrency":"USD"}},"offers":{"@type":"Offer","url":"https://bookwalker.com/volume/3R3F9SSTNYT0/the-wrong-way-to-use-healing-magic-volume-1","price":9.99,"priceCurrency":"USD","availability":"https://schema.org/InStock","itemCondition":"https://schema.org/NewCondition","seller":{"@type":"Organization","name":"BookWalker","logo":"https://bookwalker.com/icons/icon-512x512.png","url":"https://bookwalker.com/","sameAs":"https://twitter.com/BOOKWALKER_GL"},"hasMerchantReturnPolicy":{"@type":"MerchantReturnPolicy","applicableCountry":"US","returnPolicyCategory":"https://schema.org/MerchantReturnNotPermitted"},"shippingDetails":{"@type":"OfferShippingDetails","shippingRate":{"@type":"MonetaryAmount","value":0,"currency":"USD"},"deliveryTime":{"@type":"ShippingDeliveryTime","handlingTime":{"@type":"QuantitativeValue","minValue":0,"maxValue":0,"unitCode":"DAY"},"transitTime":{"@type":"QuantitativeValue","minValue":0,"maxValue":0,"unitCode":"DAY"}},"shippingDestination":{"@type":"DefinedRegion","addressCountry":"US"}}}}',
        },
        breadcrumbs: {
          sectionSha256: "f14e087a676846d1a6c7cf8af2beae06fa248753be23fc8996ffe90f248c271b",
          byteStart: 200975,
          byteEndExclusive: 201427,
          excerpt:
            '{"@context":"https://schema.org","@type":"BreadcrumbList","itemListElement":[{"@type":"ListItem","position":1,"name":"BookWalker","item":"https://bookwalker.com/"},{"@type":"ListItem","position":2,"name":"Manga","item":"https://bookwalker.com/browse?formats%5B%5D=1"},{"@type":"ListItem","position":3,"name":"The Wrong Way to Use Healing Magic Volume 1","item":"https://bookwalker.com/volume/3R3F9SSTNYT0/the-wrong-way-to-use-healing-magic-volume-1"}]}',
        },
      },
      ol: {
        kind: "olPhysicalFormatAbsent",
        key: "/books/OL39774743M",
        isbn13: "9781642732542",
        url: "https://openlibrary.org/books/OL39774743M.json",
        fetchedAt: 1791323270741,
        bodySha256: "d39c15b5aa04895cf03a79c8b76154dc47291d8a72572cd8eeb53bcd5a5660fb",
        physicalFormatAbsent: true,
        normalizedSnapshot:
          '{"format":"physical","isbn13":"9781642732542","key":"/books/OL39774743M","kind":"olEdition","multiVolume":false,"publishDate":{"year":2022},"publishers":["One Peace Books, Incorporated"],"seriesTitle":"Wrong Way to Use Healing Magic","subtitle":"The Manga Companion","title":"Wrong Way to Use Healing Magic Volume 1","url":"https://openlibrary.org/books/OL39774743M","volumeLabel":"1"}',
      },
    },
  },
  {
    wire: '{"type": {"key": "/type/edition"}, "authors": [{"key": "/authors/OL7755191A"}], "isbn_13": ["9781642733785"], "languages": [{"key": "/languages/eng"}], "publish_date": "2024", "publishers": ["One Peace Books, Incorporated"], "source_records": ["bwb:9781642733785"], "subjects": ["Comics & graphic novels, general"], "title": "Tales of the Tendo Family Volume 1", "full_title": "Tales of the Tendo Family Volume 1", "works": [{"key": "/works/OL37572690W"}], "key": "/books/OL51148506M", "latest_revision": 1, "revision": 1, "created": {"type": "/type/datetime", "value": "2024-02-18T06:46:53.618993"}, "last_modified": {"type": "/type/datetime", "value": "2024-02-18T06:46:53.618993"}}',
    frozen:
      '{"format":"physical","isbn13":"9781642733785","key":"/books/OL51148506M","kind":"olEdition","multiVolume":false,"publishDate":{"year":2024},"publishers":["One Peace Books, Incorporated"],"seriesTitle":"Tales of the Tendo Family","title":"Tales of the Tendo Family Volume 1","url":"https://openlibrary.org/books/OL51148506M","volumeLabel":"1"}',
    reviewed: {
      kind: "olInferredPhysicalToDigital",
      sourceKey: "openlibrary",
      from: "physical",
      to: "digital",
      key: "/books/OL51148506M",
      isbn13: "9781642733785",
      baseSnapshot:
        '{"format":"physical","isbn13":"9781642733785","key":"/books/OL51148506M","kind":"olEdition","multiVolume":false,"publishDate":{"year":2024},"publishers":["One Peace Books, Incorporated"],"seriesTitle":"Tales of the Tendo Family","title":"Tales of the Tendo Family Volume 1","url":"https://openlibrary.org/books/OL51148506M","volumeLabel":"1"}',
      reason:
        "Primary digital distributor's own SKU metadata and exact OL missing physical_format reviewed.",
      publisher: {
        kind: "primaryDigitalDistributorOwnSku",
        distributor: "overdrive",
        isbn13: "9781642733785",
        sku: "10544583",
        url: "https://idl.overdrive.com/media/10544583",
        httpStatus: 200,
        fetchedAt: 1791322588318,
        bodySha256: "0e457f70a817fe8337f4b3206894dc8ce2470f636aeab01d8f600ed3daaed421",
        bodyBytes: 106022,
        mediaItems: {
          sectionSha256: "3fd5669fda4dcf3af11ac05cf37f36aaa15a03409fe1d1df05884d33a2756b28",
          byteStart: 5674,
          byteEndExclusive: 10946,
          excerpt:
            '{"10544583":{"reserveId":"1c9334a3-b09f-42af-ba31-53c880ba4d01","subjects":[{"id":"12","name":"Comic and Graphic Books"},{"id":"26","name":"Fiction"},{"id":"57","name":"Mystery"},{"id":"77","name":"Romance"}],"bisacCodes":["CGN004100","CGN004180"],"bisac":[{"code":"CGN004100","description":"Comics & Graphic Novels / Manga / Crime & Mystery"},{"code":"CGN004180","description":"Comics & Graphic Novels / Manga / Romance"}],"levels":[],"creators":[{"id":3411985,"name":"Ken Saito","role":"Author","sortName":"Saito, Ken","roleDiscipline":"Text","intelligenceType":"Unknown"}],"languages":[{"id":"en","name":"English"}],"isBundledChild":false,"ratings":{"maturityLevel":{"id":"generalcontent","name":"General content"},"naughtyScore":{"id":"GeneralContent","name":"General content"}},"constraints":{"isDisneyEulaRequired":false},"reviewCounts":{"premium":1,"publisherSupplier":0},"isAvailable":true,"isPreReleaseTitle":false,"estimatedReleaseDate":"2024-04-09T04:00:00Z","sample":{"href":"https://samples.overdrive.com/?crid=1c9334a3-b09f-42af-ba31-53c880ba4d01&.epub-sample.overdrive.com"},"publisher":{"id":"269108","name":"One Peace Ebooks"},"series":"Tales of the Tendo Family Series","description":"<p>Masato, a son of the Tendo family, is meant to marry Hojo Ran, the daughter of a baron. There\'s just one problem: she\'s a fake. The real Ran has fled after hearing that few make it out of the Tendo family alive. In her place is a young woman who says she will die if it means saving someone else\'s life.","availableCopies":1,"ownedCopies":1,"luckyDayAvailableCopies":0,"luckyDayOwnedCopies":0,"holdsCount":0,"isFastlane":true,"availabilityType":"normal","isRecommendableToLibrary":true,"isOwned":true,"isHoldable":true,"isAdvantageFiltered":false,"isRestricted":false,"visitorEligible":false,"juvenileEligible":false,"youngAdultEligible":false,"contentAccessLevels":0,"classifications":{},"type":{"id":"ebook","name":"eBook"},"covers":{"cover150Wide":{"href":"https://img2.od-cdn.com/ImageType-150/2320-1/{1C9334A3-B09F-42AF-BA31-53C880BA4D01}IMG150.JPG","height":200,"width":150,"primaryColor":{"hex":"#FFFFFF","rgb":{"red":255,"green":255,"blue":255}},"isPlaceholderImage":false},"cover300Wide":{"href":"https://img2.od-cdn.com/ImageType-400/2320-1/{1C9334A3-B09F-42AF-BA31-53C880BA4D01}IMG400.JPG","height":400,"width":300,"primaryColor":{"hex":"#FFFFFF","rgb":{"red":255,"green":255,"blue":255}},"isPlaceholderImage":false},"cover510Wide":{"href":"https://img1.od-cdn.com/ImageType-100/2320-1/{1C9334A3-B09F-42AF-BA31-53C880BA4D01}IMG100.JPG","height":680,"width":510,"primaryColor":{"hex":"#FFFFFF","rgb":{"red":255,"green":255,"blue":255}},"isPlaceholderImage":false}},"id":"10544583","firstCreatorName":"Ken Saito","firstCreatorId":3411985,"firstCreatorSortName":"Saito, Ken","title":"Tales of the Tendo Family Volume 1","sortTitle":"Tales of the Tendo Family Volume 01","publishDate":"2024-04-09T00:00:00Z","publishDateText":"04/09/2024","dateContentReceivedUTC":"2024-02-26T22:36:59Z","formats":[{"identifiers":[{"type":"ASIN","value":"B0FR7MTXMP"}],"rights":[{"type":"UnsupportedKindleDevice","typeText":"Unsupported kindle device","value":"kindle-1","valueText":"Kindle 1","drmType":"Light"},{"type":"UnsupportedKindleDevice","typeText":"Unsupported kindle device","value":"kindle-2","valueText":"Kindle 2","drmType":"Light"},{"type":"UnsupportedKindleDevice","typeText":"Unsupported kindle device","value":"kindle-dx","valueText":"Kindle DX","drmType":"Light"},{"type":"UnsupportedKindleDevice","typeText":"Unsupported kindle device","value":"kindle-keyboard","valueText":"Kindle Keyboard","drmType":"Light"},{"type":"UnsupportedKindleDevice","typeText":"Unsupported kindle device","value":"kindle-4","valueText":"Kindle 4","drmType":"Light"},{"type":"UnsupportedKindleDevice","typeText":"Unsupported kindle device","value":"kindle-touch","valueText":"Kindle Touch","drmType":"Light"},{"type":"UnsupportedKindleDevice","typeText":"Unsupported kindle device","value":"kindle-5","valueText":"Kindle 5","drmType":"Light"},{"type":"UnsupportedKindleDevice","typeText":"Unsupported kindle device","value":"kindle-paperwhite","valueText":"Kindle Paperwhite","drmType":"Light"},{"type":"UnsupportedKindleDevice","typeText":"Unsupported kindle device","value":"kindle-7","valueText":"Kindle 7","drmType":"Light"},{"type":"UnsupportedKindleDevice","typeText":"Unsupported kindle device","value":"kindle-voyage","valueText":"Kindle Voyage","drmType":"Light"}],"onSaleDateUtc":"2024-04-09T04:00:00+00:00","hasAudioSynchronizedText":false,"isBundleParent":false,"bundledContent":[],"fulfillmentType":"kindle","id":"ebook-kindle","name":"Kindle Book"},{"identifiers":[{"type":"ISBN","value":"9781642733785"}],"rights":[],"onSaleDateUtc":"2024-04-09T04:00:00+00:00","hasAudioSynchronizedText":false,"isBundleParent":false,"isbn":"9781642733785","bundledContent":[],"sample":{"href":"https://samples.overdrive.com/?crid=1c9334a3-b09f-42af-ba31-53c880ba4d01&.epub-sample.overdrive.com"},"fulfillmentType":"bifocal","id":"ebook-overdrive","name":"OverDrive Read"}],"publisherAccount":{"accessId":0,"id":"6076","name":"SCB Distributors"},"detailedSeries":{"seriesId":1954648,"seriesName":"Tales of the Tendo Family Series","readingOrder":"1","rank":1},"sampleIsODR":true}}',
        },
      },
      ol: {
        kind: "olPhysicalFormatAbsent",
        key: "/books/OL51148506M",
        isbn13: "9781642733785",
        url: "https://openlibrary.org/books/OL51148506M.json",
        fetchedAt: 1791323270854,
        bodySha256: "614edf71f9df782a6b291d5406c912ff7ff108c1e480bdf4f4f02159c5dd12af",
        physicalFormatAbsent: true,
        normalizedSnapshot:
          '{"format":"physical","isbn13":"9781642733785","key":"/books/OL51148506M","kind":"olEdition","multiVolume":false,"publishDate":{"year":2024},"publishers":["One Peace Books, Incorporated"],"seriesTitle":"Tales of the Tendo Family","title":"Tales of the Tendo Family Volume 1","url":"https://openlibrary.org/books/OL51148506M","volumeLabel":"1"}',
      },
    },
  },
] as const;

// One Peace's own OverDrive SKU for Hinamatsuri Volume 16, whose metadata has no
// detailedSeries, captured 2026-10-06 with its full body retained
// (r13 onepeace-sku-index, od-sku-9099449.body). The snapshot is the held OL
// record's stored normalized source (r11 one-peace-2).
const missingOrderSnapshot: OlEditionSnapshot = {
  format: "physical",
  isbn13: "9781642732269",
  key: "/books/OL38904571M",
  kind: "olEdition",
  multiVolume: false,
  publishDate: {
    year: 2022,
  },
  publishers: ["One Peace Books, Incorporated"],
  seriesTitle: "Hinamatsuri",
  title: "Hinamatsuri Volume 16",
  url: "https://openlibrary.org/books/OL38904571M",
  volumeLabel: "16",
};
export const missingOrderEvidence = {
  snapshot: missingOrderSnapshot,
  publisher: {
    kind: "primaryDigitalDistributorOwnSku",
    distributor: "overdrive",
    isbn13: "9781642732269",
    sku: "9099449",
    url: "https://freelibrary.overdrive.com/media/9099449",
    httpStatus: 200,
    fetchedAt: 1791325092815,
    bodySha256: "5eaec170ad2807df0932ac70dc66846efae115d86010bd8a4cb495b5886f2b47",
    bodyBytes: 113351,
    mediaItems: {
      sectionSha256: "193fcac9248fb30e60927c421bf59c054b81aa6810483237fe3f5b7c70a7182a",
      byteStart: 5716,
      byteEndExclusive: 11179,
      excerpt:
        '{"9099449":{"reserveId":"6ae3f3b0-26ea-45e1-9d52-24980bd5089c","subjects":[{"id":"12","name":"Comic and Graphic Books"},{"id":"24","name":"Fantasy"},{"id":"123","name":"Humor (Fiction)"},{"id":"127","name":"Young Adult Fiction"}],"bisacCodes":["CGN004250","CGN004290"],"bisac":[{"code":"CGN004250","description":"Comics & Graphic Novels / Manga / Humorous"},{"code":"CGN004290","description":"Comics & Graphic Novels / Manga / Supernatural"}],"levels":[],"creators":[{"id":1835231,"name":"Masao Ohtake","role":"Author","sortName":"Ohtake, Masao","roleDiscipline":"Text","intelligenceType":"Unknown"}],"languages":[{"id":"en","name":"English"}],"isBundledChild":false,"ratings":{"maturityLevel":{"id":"youngadult","name":"Young adult"},"naughtyScore":{"id":"YoungAdult","name":"Young adult"}},"constraints":{"isDisneyEulaRequired":false},"reviewCounts":{"premium":0,"publisherSupplier":0},"isAvailable":true,"isPreReleaseTitle":false,"estimatedReleaseDate":"2022-08-16T04:00:00Z","sample":{"href":"https://samples.overdrive.com/?crid=6ae3f3b0-26ea-45e1-9d52-24980bd5089c&.epub-sample.overdrive.com"},"publisher":{"id":"269108","name":"One Peace Ebooks"},"description":"<p>apan is on the edge of a new era, and Nitta the Monster has one final piece of business to take care of: making amends with Anzu.\\nHe can\'t stop thinking about the countless evenings he\'s enjoyed at the cart over a steaming bowl of ramen, and he\'s prepared to do whatever it takes to reclaim that tiny taste of how great fatherhood can be.\\nMeanwhile, the hilarious confrontations continue, this time with Hina vs. Haru, Mika Nitta vs. the Teihen High Karate Club, and Mao vs. the entire Way of the Supreme Fist.\\nPrepare for showdowns galore in this action-packed new volume of Hinamatsuri!","availableCopies":1,"ownedCopies":1,"luckyDayAvailableCopies":0,"luckyDayOwnedCopies":0,"holdsCount":0,"holdsRatio":0,"estimatedWaitDays":14,"isFastlane":false,"availabilityType":"normal","isRecommendableToLibrary":true,"isOwned":true,"isHoldable":true,"isAdvantageFiltered":false,"isRestricted":false,"visitorEligible":false,"juvenileEligible":false,"youngAdultEligible":false,"contentAccessLevels":0,"classifications":{},"type":{"id":"ebook","name":"eBook"},"covers":{"cover150Wide":{"href":"https://img3.od-cdn.com/ImageType-150/2320-1/{6AE3F3B0-26EA-45E1-9D52-24980BD5089C}IMG150.JPG","height":200,"width":150,"primaryColor":{"hex":"#F9E4A3","rgb":{"red":249,"green":228,"blue":163}},"isPlaceholderImage":false},"cover300Wide":{"href":"https://img1.od-cdn.com/ImageType-400/2320-1/{6AE3F3B0-26EA-45E1-9D52-24980BD5089C}IMG400.JPG","height":400,"width":300,"primaryColor":{"hex":"#F8E098","rgb":{"red":248,"green":224,"blue":152}},"isPlaceholderImage":false},"cover510Wide":{"href":"https://img2.od-cdn.com/ImageType-100/2320-1/{6AE3F3B0-26EA-45E1-9D52-24980BD5089C}IMG100.JPG","height":680,"width":510,"primaryColor":{"hex":"#F6DE96","rgb":{"red":246,"green":222,"blue":150}},"isPlaceholderImage":false}},"id":"9099449","firstCreatorName":"Masao Ohtake","firstCreatorId":1835231,"firstCreatorSortName":"Ohtake, Masao","title":"Hinamatsuri Volume 16","sortTitle":"Hinamatsuri Volume 16","starRating":5,"starRatingCount":1,"publishDate":"2022-08-16T00:00:00Z","publishDateText":"08/16/2022","dateContentReceivedUTC":"2022-07-01T17:23:58Z","formats":[{"identifiers":[{"type":"ASIN","value":"B0FVB5T5YF"}],"rights":[{"type":"UnsupportedKindleDevice","typeText":"Unsupported kindle device","value":"kindle-1","valueText":"Kindle 1","drmType":"Light"},{"type":"UnsupportedKindleDevice","typeText":"Unsupported kindle device","value":"kindle-2","valueText":"Kindle 2","drmType":"Light"},{"type":"UnsupportedKindleDevice","typeText":"Unsupported kindle device","value":"kindle-dx","valueText":"Kindle DX","drmType":"Light"},{"type":"UnsupportedKindleDevice","typeText":"Unsupported kindle device","value":"kindle-keyboard","valueText":"Kindle Keyboard","drmType":"Light"},{"type":"UnsupportedKindleDevice","typeText":"Unsupported kindle device","value":"kindle-4","valueText":"Kindle 4","drmType":"Light"},{"type":"UnsupportedKindleDevice","typeText":"Unsupported kindle device","value":"kindle-touch","valueText":"Kindle Touch","drmType":"Light"},{"type":"UnsupportedKindleDevice","typeText":"Unsupported kindle device","value":"kindle-5","valueText":"Kindle 5","drmType":"Light"},{"type":"UnsupportedKindleDevice","typeText":"Unsupported kindle device","value":"kindle-paperwhite","valueText":"Kindle Paperwhite","drmType":"Light"},{"type":"UnsupportedKindleDevice","typeText":"Unsupported kindle device","value":"kindle-7","valueText":"Kindle 7","drmType":"Light"},{"type":"UnsupportedKindleDevice","typeText":"Unsupported kindle device","value":"kindle-voyage","valueText":"Kindle Voyage","drmType":"Light"}],"onSaleDateUtc":"2022-08-16T04:00:00+00:00","hasAudioSynchronizedText":false,"isBundleParent":false,"bundledContent":[],"fulfillmentType":"kindle","id":"ebook-kindle","name":"Kindle Book"},{"identifiers":[{"type":"ISBN","value":"9781642732269"}],"rights":[],"onSaleDateUtc":"2022-08-16T04:00:00+00:00","hasAudioSynchronizedText":false,"isBundleParent":false,"isbn":"9781642732269","bundledContent":[],"sample":{"href":"https://samples.overdrive.com/?crid=6ae3f3b0-26ea-45e1-9d52-24980bd5089c&.epub-sample.overdrive.com"},"fulfillmentType":"bifocal","id":"ebook-overdrive","name":"OverDrive Read"}],"publisherAccount":{"accessId":0,"id":"6076","name":"SCB Distributors"},"sampleIsODR":true}}',
    },
  },
} as const;
