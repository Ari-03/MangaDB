// A publisher's own ISBN blocks: the ISBN-13 prefixes its registrant ranges
// assign from, by canonical publisher slug (lib/publishers.ts). Reviewed
// decisions about ISBNs the publisher's catalog never lists (an alternate
// ebook ISBN, alternateEbooks.ts; an unlisted reserved number, scope.ts)
// accept only ISBNs inside the publisher's own blocks. A publisher not listed
// here has no such decision. `catalogSourceKey` names the import of the
// publisher's own catalog, keyed by ISBN-13, when there is one.

import type { Doc } from "../_generated/dataModel";

type IsbnBlocks = { prefixes: readonly string[]; catalogSourceKey?: string };

const BLOCKS: Readonly<Record<string, IsbnBlocks>> = {
  // 978-0-316 (Little, Brown, which Yen Press assigns from) and 978-1-975.
  "yen-press": { prefixes: ["9780316", "9781975"], catalogSourceKey: "yenpress" },
};

/** The publisher's own ISBN blocks, or undefined when none are known. */
export function publisherIsbnBlocks(publisher: Pick<Doc<"publishers">, "slug">) {
  return BLOCKS[publisher.slug];
}

/** Whether ISBN-13 `isbn13` sits in one of the publisher's own blocks. */
export function inPublisherBlock(
  publisher: Pick<Doc<"publishers">, "slug">,
  isbn13: string,
): boolean {
  return publisherIsbnBlocks(publisher)?.prefixes.some((p) => isbn13.startsWith(p)) ?? false;
}
