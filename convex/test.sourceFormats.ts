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
