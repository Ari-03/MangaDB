// Saved public bytes for two held Tokyopop PDFs, captured 2026-10-06: the
// Open Library edition JSON and the product object Tokyopop's own Shopify
// store returns for each exact PDF SKU, sliced from its products.json page
// (status 200, 542344 bytes) at the recorded byte range. Source:
// tokyopop-1 and tokyopop-digital-model-plan review artifacts. No live IDs.
// Dramacon 2 is a TOKYOPOP Classics PDF; Dark Metro 1 the parent's.
export const tokyopopPdfEvidence = [
  {
    wire: '{"type": {"key": "/type/edition"}, "authors": [{"key": "/authors/OL3030385A"}], "isbn_13": ["9781427860828"], "languages": [{"key": "/languages/eng"}], "pagination": "192", "publish_date": "2023", "publishers": ["TOKYOPOP, Incorporated"], "source_records": ["bwb:9781427860828"], "subjects": ["Love, fiction"], "title": "Dramacon, Volume 2", "full_title": "Dramacon, Volume 2", "works": [{"key": "/works/OL35709244W"}], "key": "/books/OL49269788M", "latest_revision": 1, "revision": 1, "created": {"type": "/type/datetime", "value": "2023-08-17T03:46:46.421599"}, "last_modified": {"type": "/type/datetime", "value": "2023-08-17T03:46:46.421599"}}',
    olUrl: "https://openlibrary.org/books/OL49269788M.json",
    olFetchedAt: 1791322334328,
    olBodySha256: "126a2cb19defb9d5ed3b8d4525ea992213c006bc2218e5e242b32fdd540e06ea",
    product: {
      kind: "publisherOwnShopifySkuEbook" as const,
      isbn13: "9781427860828",
      sku: "9781427860828",
      url: "https://tokyopop.com/products.json?limit=250&page=4",
      httpStatus: 200 as const,
      fetchedAt: 1791309619787,
      bodySha256: "b16ca7dab61617ea2e45f54fac6bab1e9af5870a22902e18ffa69a7bc83288ef",
      bodyBytes: 542344,
      product: {
        sectionSha256: "cb1e96e1dea668d5773ef859ef44ea56f4110ac5cfe65c0d3252a4814e052b84",
        byteStart: 417054,
        byteEndExclusive: 418805,
        excerpt:
          '{"id":7611349762235,"title":"Dramacon, Volume 2","handle":"9781427860828_dramacon-volume-2","body_html":"\\u003cdiv\\u003eIt\'s Christie\'s second year at the Lakeside Anime Convention and the drama picks up right where it left off in Dramacon volume one! With her new partner-in-crime, a.k.a. artiste extraordinaire Bethany, she is promoting her latest comic. Matt is also back, but to Christie\'s shock, he now has a girlfriend!\\u003c\\/div\\u003e","published_at":"2022-08-10T15:26:53-07:00","created_at":"2022-08-10T15:26:54-07:00","updated_at":"2026-10-06T11:00:20-07:00","vendor":"Svetlana Chmakova","product_type":"eBook","tags":["age:12+","bic FXA:Fiction \\u0026 related items \\/ Graphic novels: Manga","bisac:COMICS \\u0026 GRAPHIC NOVELS \\/ General","contributor:Svetlana Chmakova","format-detail:PDF","format:eBook","imprint:TOKYOPOP Classics","price:7.99","publication-date:2018-12-03","publisher:TOKYOPOP","series:dramacon-manga","type:Nonfiction"],"variants":[{"id":43222371631291,"title":"Default Title","option1":"Default Title","option2":null,"option3":null,"sku":"9781427860828","requires_shipping":false,"taxable":true,"featured_image":null,"available":true,"price":"7.99","grams":0,"compare_at_price":null,"position":1,"product_id":7611349762235,"created_at":"2022-08-10T15:26:55-07:00","updated_at":"2026-10-06T11:00:20-07:00"}],"images":[{"id":34575675326651,"created_at":"2023-06-18T20:11:06-07:00","position":1,"updated_at":"2026-04-10T14:57:53-07:00","product_id":7611349762235,"variant_ids":[],"src":"https:\\/\\/cdn.shopify.com\\/s\\/files\\/1\\/0599\\/7114\\/1819\\/products\\/9781427860828_e0abbe47-4f52-4ecf-b8a3-5e585adc4fce.jpg?v=1775858273","width":432,"height":648}],"options":[{"name":"Title","position":1,"values":["Default Title"]}]}',
      },
      digitalFileFormat: "pdf" as const,
      imprint: "TOKYOPOP Classics",
      publishDate: { year: 2018, month: 12, day: 3 },
    },
  },
  {
    wire: '{"type": {"key": "/type/edition"}, "authors": [{"key": "/authors/OL3774619A"}, {"key": "/authors/OL3774620A"}], "isbn_13": ["9781427861351"], "languages": [{"key": "/languages/eng"}], "pagination": "192", "publish_date": "2020", "publishers": ["TOKYOPOP, Incorporated"], "source_records": ["bwb:9781427861351"], "title": "Dark Metro, Volume 1", "full_title": "Dark Metro, Volume 1", "works": [{"key": "/works/OL35781102W"}], "key": "/books/OL49275245M", "latest_revision": 1, "revision": 1, "created": {"type": "/type/datetime", "value": "2023-08-17T04:05:07.871583"}, "last_modified": {"type": "/type/datetime", "value": "2023-08-17T04:05:07.871583"}}',
    olUrl: "https://openlibrary.org/books/OL49275245M.json",
    olFetchedAt: 1791322334394,
    olBodySha256: "54726c758feea85217d33dc455180d36ecfcc4a2cd8cc2af63140ba633f4635f",
    product: {
      kind: "publisherOwnShopifySkuEbook" as const,
      isbn13: "9781427861351",
      sku: "9781427861351",
      url: "https://tokyopop.com/products.json?limit=250&page=4",
      httpStatus: 200 as const,
      fetchedAt: 1791309619787,
      bodySha256: "b16ca7dab61617ea2e45f54fac6bab1e9af5870a22902e18ffa69a7bc83288ef",
      bodyBytes: 542344,
      product: {
        sectionSha256: "776413fdd7dfe5c75f8f2e83b181c5e6da63d8c4abe9c99ded6b45c429468b6a",
        byteStart: 412121,
        byteEndExclusive: 413823,
        excerpt:
          '{"id":7611349893307,"title":"Dark Metro, Volume 1","handle":"9781427861351_dark-metro-volume-1","body_html":"\\u003cdiv\\u003eAnna almost descends to the dark side when she follows the suicidal Rei down an escalator to hell. Seiya pulls her back, but will they make it out of Tokyo\'s secret metro lines in time to escape Rei and the ghosts who inhabit the Tokyo underground?\\u003c\\/div\\u003e","published_at":"2022-08-10T15:27:02-07:00","created_at":"2022-08-10T15:27:06-07:00","updated_at":"2026-10-06T11:00:20-07:00","vendor":"Tokyo Calen","product_type":"eBook","tags":["age:16+","bic FXA:Fiction \\u0026 related items \\/ Graphic novels: Manga","bisac:COMICS \\u0026 GRAPHIC NOVELS \\/ General","contributor:Tokyo Calen","contributor:Yoshiken","format-detail:PDF","format:eBook","imprint:TOKYOPOP","price:7.99","publication-date:2020-04-10","publisher:TOKYOPOP","series:dark-metro-manga","type:Nonfiction"],"variants":[{"id":43222372057275,"title":"Default Title","option1":"Default Title","option2":null,"option3":null,"sku":"9781427861351","requires_shipping":false,"taxable":true,"featured_image":null,"available":true,"price":"7.99","grams":0,"compare_at_price":null,"position":1,"product_id":7611349893307,"created_at":"2022-08-10T15:27:07-07:00","updated_at":"2026-10-06T11:00:20-07:00"}],"images":[{"id":34575675556027,"created_at":"2023-06-18T20:11:14-07:00","position":1,"updated_at":"2026-04-10T14:57:56-07:00","product_id":7611349893307,"variant_ids":[],"src":"https:\\/\\/cdn.shopify.com\\/s\\/files\\/1\\/0599\\/7114\\/1819\\/products\\/9781427861351_3cfe36a9-cfd5-4db3-b8e7-abc340aa7f61.jpg?v=1775858276","width":436,"height":648}],"options":[{"name":"Title","position":1,"values":["Default Title"]}]}',
      },
      digitalFileFormat: "pdf" as const,
      imprint: "TOKYOPOP",
      publishDate: { year: 2020, month: 4, day: 10 },
    },
  },
] as const;

/** The exact EPUB format object PRH's own page attaches to Dramacon 2's EPUB, 9781427860835. */
export const dramaconEpubPrhFormat = {
  code: "EL",
  name: "Ebook",
  subcode: "045",
  subname: "EPUB FXL Manga RTL",
  family: "Ebook",
  description: "eBook",
} as const;
