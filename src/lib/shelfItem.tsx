import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { Cover } from "~/lib/cover";
import { slugParams } from "~/lib/slug";

/**
 * A Series as one book on a shelf of covers (styles/covers.css): its jacket
 * and its title, both linking the Series page. The cover repeats the title
 * link, so it stays out of the tab order. `children` follow the title in
 * the caption (counts, publishers, chips).
 */
export function SeriesShelfItem({
  series,
  lazy,
  children,
}: {
  series: {
    publicId: number;
    title: string;
    coverUrl: string | null;
    coverIsbn: string | ReadonlyArray<string> | null;
  };
  /** As on Cover: `false` for the first covers above the fold. */
  lazy?: boolean;
  children?: ReactNode;
}) {
  const params = slugParams(series.publicId, series.title);
  return (
    <div className="shelf-item">
      <div className="cover-wrap">
        <Link
          className="cover-link"
          to="/series/$publicId/$slug"
          params={params}
          tabIndex={-1}
          aria-hidden="true"
        >
          <Cover src={series.coverUrl} isbn13={series.coverIsbn} title={series.title} lazy={lazy} />
        </Link>
      </div>
      <div className="caption">
        <Link className="caption-title" to="/series/$publicId/$slug" params={params}>
          {series.title}
        </Link>
        {children}
      </div>
    </div>
  );
}
