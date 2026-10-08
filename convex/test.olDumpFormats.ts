import type { OlEditionSnapshot } from "./lib/openLibrary";
import type { ReviewedFormat } from "./lib/sourceFormat";

// Two held One Peace manga ebooks whose OL record has no physical_format,
// as lines of Open Library's 2026-09-30 monthly editions dump (MD5 matched
// archive.org's; streamed SHA-256 recorded on retrieval 2026-10-07T15:12:41Z), with
// the stored staging snapshots and the BookWalker own-SKU sections retained
// by native-review-004. A dump line is a dated bulk-export record, not a
// live response. Source: held-books-20261007 shared-ol-dumps-001.
// Shield Hero 8's line states the subtitle the stored snapshot predates;
// Nukozuke 1's reparses to its stored snapshot exactly.
export const dumpFormatEvidence: {
  observationId: string;
  snapshot: OlEditionSnapshot;
  reviewed: ReviewedFormat;
}[] = [
  {
    observationId: "n977jvmwe22np9agbrexmjr4458f4hrp",
    snapshot: {
      format: "physical",
      isbn13: "9781642730081",
      key: "/books/OL35953803M",
      kind: "olEdition",
      multiVolume: false,
      publishDate: {
        year: 2020,
      },
      publishers: ["One Peace Books, Incorporated"],
      seriesTitle: "Rising of the Shield Hero",
      title: "Rising of the Shield Hero Volume 08",
      url: "https://openlibrary.org/books/OL35953803M",
      volumeLabel: "8",
    },
    reviewed: {
      kind: "olInferredPhysicalToDigital",
      sourceKey: "openlibrary",
      from: "physical",
      to: "digital",
      key: "/books/OL35953803M",
      isbn13: "9781642730081",
      baseSnapshot:
        '{"format":"physical","isbn13":"9781642730081","key":"/books/OL35953803M","kind":"olEdition","multiVolume":false,"publishDate":{"year":2020},"publishers":["One Peace Books, Incorporated"],"seriesTitle":"Rising of the Shield Hero","title":"Rising of the Shield Hero Volume 08","url":"https://openlibrary.org/books/OL35953803M","volumeLabel":"8"}',
      reason:
        "Primary digital distributor's own SKU metadata, and the exact record's line in Open Library's 2026-09-30 monthly editions dump with no physical_format, reviewed.",
      publisher: {
        kind: "primaryDigitalDistributorOwnSku",
        distributor: "bookwalker",
        isbn13: "9781642730081",
        sku: "1R6XAEN8CTHG",
        url: "https://bookwalker.com/volume/1R6XAEN8CTHG/the-rising-of-the-shield-hero-volume-8-the-manga-companion",
        httpStatus: 200,
        fetchedAt: 1791372731898,
        bodySha256: "ee2e32e4e7f92e98a30eedd6e3baaccd69602a5c9ae30e2ca772cd1b8ee594c0",
        bodyBytes: 340540,
        product: {
          sectionSha256: "deb70be28b9e01ed91a8a2db3d41a35f6aced42fdacd40d7d91c351c5cb1d77d",
          byteStart: 200169,
          byteEndExclusive: 202283,
          excerpt:
            '{"@context":"https://schema.org","@type":["Product","Book"],"@id":"https://bookwalker.com/volume/1R6XAEN8CTHG","name":"The Rising of the Shield Hero Volume 8: The Manga Companion","url":"https://bookwalker.com/volume/1R6XAEN8CTHG/the-rising-of-the-shield-hero-volume-8-the-manga-companion","inLanguage":"en","description":"Rising from the depths of despair, this is a fantasy about persistence.","image":"https://img.sos-dan.net/1200/01K/G/A/3FZXTD26J5QQSCCNM75DG.webp","bookFormat":"https://schema.org/EBook","isbn":"9781642730081","author":{"@type":"Person","name":"Aneko Yusagi"},"brand":{"@type":"Brand","name":"One Peace Books"},"datePublished":"2018-05-29T07:00:00.000Z","potentialAction":{"@type":"ReadAction","target":{"@type":"EntryPoint","urlTemplate":"https://bookwalker.com/volume/1R6XAEN8CTHG/the-rising-of-the-shield-hero-volume-8-the-manga-companion","actionPlatform":["https://schema.org/DesktopWebPlatform","https://schema.org/AndroidPlatform","https://schema.org/IOSPlatform"]},"expectsAcceptanceOf":{"@type":"Offer","category":"purchase","price":9.99,"priceCurrency":"USD"}},"offers":{"@type":"Offer","url":"https://bookwalker.com/volume/1R6XAEN8CTHG/the-rising-of-the-shield-hero-volume-8-the-manga-companion","price":9.99,"priceCurrency":"USD","availability":"https://schema.org/InStock","itemCondition":"https://schema.org/NewCondition","seller":{"@type":"Organization","name":"BookWalker","logo":"https://bookwalker.com/icons/icon-512x512.png","url":"https://bookwalker.com/","sameAs":"https://twitter.com/BOOKWALKER_GL"},"hasMerchantReturnPolicy":{"@type":"MerchantReturnPolicy","applicableCountry":"US","returnPolicyCategory":"https://schema.org/MerchantReturnNotPermitted"},"shippingDetails":{"@type":"OfferShippingDetails","shippingRate":{"@type":"MonetaryAmount","value":0,"currency":"USD"},"deliveryTime":{"@type":"ShippingDeliveryTime","handlingTime":{"@type":"QuantitativeValue","minValue":0,"maxValue":0,"unitCode":"DAY"},"transitTime":{"@type":"QuantitativeValue","minValue":0,"maxValue":0,"unitCode":"DAY"}},"shippingDestination":{"@type":"DefinedRegion","addressCountry":"US"}}}}',
        },
        breadcrumbs: {
          sectionSha256: "73adb1bd7ddbafc42876dcfe497f3154076047359548808a8fbd757a2204c3af",
          byteStart: 199642,
          byteEndExclusive: 200125,
          excerpt:
            '{"@context":"https://schema.org","@type":"BreadcrumbList","itemListElement":[{"@type":"ListItem","position":1,"name":"BookWalker","item":"https://bookwalker.com/"},{"@type":"ListItem","position":2,"name":"Manga","item":"https://bookwalker.com/browse?formats%5B%5D=1"},{"@type":"ListItem","position":3,"name":"The Rising of the Shield Hero Volume 8: The Manga Companion","item":"https://bookwalker.com/volume/1R6XAEN8CTHG/the-rising-of-the-shield-hero-volume-8-the-manga-companion"}]}',
        },
      },
      ol: {
        kind: "olDumpEditionPhysicalFormatAbsent",
        key: "/books/OL35953803M",
        isbn13: "9781642730081",
        url: "https://archive.org/download/ol_dump_2026-09-30/ol_dump_editions_2026-09-30.txt.gz",
        dump: {
          file: "ol_dump_editions_2026-09-30.txt.gz",
          date: "2026-09-30",
          archiveMd5: "615bfae55bfc4581bded0e43909b3f42",
          streamedSha256: "0c30ebacc2fa1453fd644c5823a64b6b294c97d650b603eea46f6cbb26a010e7",
          retrievedAt: 1791385961000,
        },
        line: '/type/edition\t/books/OL35953803M\t1\t2021-12-27T06:58:15.927625\t{"type": {"key": "/type/edition"}, "authors": [{"key": "/authors/OL7622364A"}, {"key": "/authors/OL9558354A"}, {"key": "/authors/OL7909088A"}], "isbn_13": ["9781642730081"], "languages": [{"key": "/languages/eng"}], "pagination": "200", "publish_date": "2020", "publishers": ["One Peace Books, Incorporated"], "source_records": ["bwb:9781642730081"], "subjects": ["Comics & graphic novels, general"], "title": "Rising of the Shield Hero Volume 08", "subtitle": "The Manga Companion", "full_title": "Rising of the Shield Hero Volume 08 The Manga Companion", "works": [{"key": "/works/OL26563049W"}], "key": "/books/OL35953803M", "latest_revision": 1, "revision": 1, "created": {"type": "/type/datetime", "value": "2021-12-27T06:58:15.927625"}, "last_modified": {"type": "/type/datetime", "value": "2021-12-27T06:58:15.927625"}}',
        lineSha256: "94406c540cd71463a3741b66d35cf126cecca967952779e88680a8babb83bf01",
        revision: 1,
        lastModified: "2021-12-27T06:58:15.927625",
        physicalFormatAbsent: true,
        schemaAddedFields: ["subtitle"],
        normalizedSnapshot:
          '{"format":"physical","isbn13":"9781642730081","key":"/books/OL35953803M","kind":"olEdition","multiVolume":false,"publishDate":{"year":2020},"publishers":["One Peace Books, Incorporated"],"seriesTitle":"Rising of the Shield Hero","title":"Rising of the Shield Hero Volume 08","url":"https://openlibrary.org/books/OL35953803M","volumeLabel":"8"}',
      },
    },
  },
  {
    observationId: "n977evtbvm9jvdb22gqw0wr3058f4686",
    snapshot: {
      format: "physical",
      isbn13: "9781642734294",
      key: "/books/OL56898159M",
      kind: "olEdition",
      multiVolume: false,
      publishDate: {
        year: 2024,
      },
      publishers: ["One Peace Books, Incorporated"],
      seriesTitle: "Nukozuke!",
      title: "Nukozuke! Volume 1",
      url: "https://openlibrary.org/books/OL56898159M",
      volumeLabel: "1",
    },
    reviewed: {
      kind: "olInferredPhysicalToDigital",
      sourceKey: "openlibrary",
      from: "physical",
      to: "digital",
      key: "/books/OL56898159M",
      isbn13: "9781642734294",
      baseSnapshot:
        '{"format":"physical","isbn13":"9781642734294","key":"/books/OL56898159M","kind":"olEdition","multiVolume":false,"publishDate":{"year":2024},"publishers":["One Peace Books, Incorporated"],"seriesTitle":"Nukozuke!","title":"Nukozuke! Volume 1","url":"https://openlibrary.org/books/OL56898159M","volumeLabel":"1"}',
      reason:
        "Primary digital distributor's own SKU metadata, and the exact record's line in Open Library's 2026-09-30 monthly editions dump with no physical_format, reviewed.",
      publisher: {
        kind: "primaryDigitalDistributorOwnSku",
        distributor: "bookwalker",
        isbn13: "9781642734294",
        sku: "2MY13VMPZMY0",
        url: "https://bookwalker.com/volume/2MY13VMPZMY0/nukozuke-volume-1",
        httpStatus: 200,
        fetchedAt: 1791372731893,
        bodySha256: "668386879ed16637ca3a6a7adaa9380f576cd2d007480edcadd5d14eefe9e3e2",
        bodyBytes: 337172,
        product: {
          sectionSha256: "2f30ca5bd0f1a8b8c511c9c21938fcb8263f60c02b3aac6136cde01cceb1acdd",
          byteStart: 197598,
          byteEndExclusive: 200040,
          excerpt:
            '{"@context":"https://schema.org","@type":["Product","Book"],"@id":"https://bookwalker.com/volume/2MY13VMPZMY0","name":"Nukozuke! Volume 1","url":"https://bookwalker.com/volume/2MY13VMPZMY0/nukozuke-volume-1","inLanguage":"en","description":"A pocket-sized cat-human: have you met a Nuko? In a world where these curious creatures evolved from ordinary cats, part-timer Yuya finds two abandoned nukos on the side of the road and brings them home out of the rain. Kei needs his ducks to be in a row, while Sasame charms everyone she meets. Yuya\'s got the cooking and sewing skills to take care of these adorable new housemates, but when he\'s the one falling asleep in any warm spot of sunlight, who\'s really taking care of who?! Kick back and let this human, his nukos, and their ameowsing life warm your heart!","image":"https://img.sos-dan.net/1200/01K/G/B/D53YQQTTED28QD6SKN5F0.webp","bookFormat":"https://schema.org/EBook","isbn":"9781642734294","author":{"@type":"Person","name":"Yugi Iro"},"brand":{"@type":"Brand","name":"One Peace Books"},"datePublished":"2024-09-28T07:00:00.000Z","potentialAction":{"@type":"ReadAction","target":{"@type":"EntryPoint","urlTemplate":"https://bookwalker.com/volume/2MY13VMPZMY0/nukozuke-volume-1","actionPlatform":["https://schema.org/DesktopWebPlatform","https://schema.org/AndroidPlatform","https://schema.org/IOSPlatform"]},"expectsAcceptanceOf":{"@type":"Offer","category":"purchase","price":9.99,"priceCurrency":"USD"}},"offers":{"@type":"Offer","url":"https://bookwalker.com/volume/2MY13VMPZMY0/nukozuke-volume-1","price":9.99,"priceCurrency":"USD","availability":"https://schema.org/InStock","itemCondition":"https://schema.org/NewCondition","seller":{"@type":"Organization","name":"BookWalker","logo":"https://bookwalker.com/icons/icon-512x512.png","url":"https://bookwalker.com/","sameAs":"https://twitter.com/BOOKWALKER_GL"},"hasMerchantReturnPolicy":{"@type":"MerchantReturnPolicy","applicableCountry":"US","returnPolicyCategory":"https://schema.org/MerchantReturnNotPermitted"},"shippingDetails":{"@type":"OfferShippingDetails","shippingRate":{"@type":"MonetaryAmount","value":0,"currency":"USD"},"deliveryTime":{"@type":"ShippingDeliveryTime","handlingTime":{"@type":"QuantitativeValue","minValue":0,"maxValue":0,"unitCode":"DAY"},"transitTime":{"@type":"QuantitativeValue","minValue":0,"maxValue":0,"unitCode":"DAY"}},"shippingDestination":{"@type":"DefinedRegion","addressCountry":"US"}}}}',
        },
        breadcrumbs: {
          sectionSha256: "e8b530cd897a1a637d960ba40026effe6eb40a18fa80f17cab148227727087c0",
          byteStart: 197153,
          byteEndExclusive: 197554,
          excerpt:
            '{"@context":"https://schema.org","@type":"BreadcrumbList","itemListElement":[{"@type":"ListItem","position":1,"name":"BookWalker","item":"https://bookwalker.com/"},{"@type":"ListItem","position":2,"name":"Manga","item":"https://bookwalker.com/browse?formats%5B%5D=1"},{"@type":"ListItem","position":3,"name":"Nukozuke! Volume 1","item":"https://bookwalker.com/volume/2MY13VMPZMY0/nukozuke-volume-1"}]}',
        },
      },
      ol: {
        kind: "olDumpEditionPhysicalFormatAbsent",
        key: "/books/OL56898159M",
        isbn13: "9781642734294",
        url: "https://archive.org/download/ol_dump_2026-09-30/ol_dump_editions_2026-09-30.txt.gz",
        dump: {
          file: "ol_dump_editions_2026-09-30.txt.gz",
          date: "2026-09-30",
          archiveMd5: "615bfae55bfc4581bded0e43909b3f42",
          streamedSha256: "0c30ebacc2fa1453fd644c5823a64b6b294c97d650b603eea46f6cbb26a010e7",
          retrievedAt: 1791385961000,
        },
        line: '/type/edition\t/books/OL56898159M\t1\t2024-10-06T05:20:08.650384\t{"type": {"key": "/type/edition"}, "authors": [{"key": "/authors/OL13667862A"}, {"key": "/authors/OL10484915A"}], "isbn_13": ["9781642734294"], "languages": [{"key": "/languages/eng"}], "publish_date": "2024", "publishers": ["One Peace Books, Incorporated"], "source_records": ["bwb:9781642734294"], "subjects": ["Comics & graphic novels, general"], "title": "Nukozuke! Volume 1", "works": [{"key": "/works/OL41898947W"}], "key": "/books/OL56898159M", "latest_revision": 1, "revision": 1, "created": {"type": "/type/datetime", "value": "2024-10-06T05:20:08.650384"}, "last_modified": {"type": "/type/datetime", "value": "2024-10-06T05:20:08.650384"}}',
        lineSha256: "f3898ced8df77a1b1644171d51f424e710e3aaa34064cdf632728ffc497114a8",
        revision: 1,
        lastModified: "2024-10-06T05:20:08.650384",
        physicalFormatAbsent: true,
        schemaAddedFields: [],
        normalizedSnapshot:
          '{"format":"physical","isbn13":"9781642734294","key":"/books/OL56898159M","kind":"olEdition","multiVolume":false,"publishDate":{"year":2024},"publishers":["One Peace Books, Incorporated"],"seriesTitle":"Nukozuke!","title":"Nukozuke! Volume 1","url":"https://openlibrary.org/books/OL56898159M","volumeLabel":"1"}',
      },
    },
  },
];

// A real line of the same dump that states physical_format "Paperback".
export const statedFormatLine =
  '/type/edition\t/books/OL38928733M\t7\t2023-03-21T07:36:42.761862\t{"type": {"key": "/type/edition"}, "authors": [{"key": "/authors/OL7529503A"}], "languages": [{"key": "/languages/eng"}], "publish_date": "2023", "publishers": ["One Peace Books, Incorporated", "One Peace Books"], "source_records": ["bwb:9781642732337", "amazon:1642732338"], "subjects": ["Comics & graphic novels, general"], "title": "I Hear the Sunspot", "subtitle": "Four Seasons", "full_title": "I Hear the Sunspot Four Seasons", "works": [{"key": "/works/OL34523984W"}], "key": "/books/OL38928733M", "identifiers": {}, "classifications": {}, "covers": [13368047], "isbn_13": ["9781642732337"], "number_of_pages": 256, "physical_format": "Paperback", "latest_revision": 7, "revision": 7, "created": {"type": "/type/datetime", "value": "2022-07-20T01:04:12.827354"}, "last_modified": {"type": "/type/datetime", "value": "2023-03-21T07:36:42.761862"}}';
