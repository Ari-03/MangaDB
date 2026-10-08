// The per-Series "see something missing/wrong? → report" affordance
// (spec §7). Renders on every Series page and sends the reader to the
// MangaDB Discord, whose channels take bug reports, suggestions and series
// requests. It is static, so SSR renders it identically for everyone.

import { DISCORD_INVITE_URL, DiscordIcon } from "~/lib/community";

export function SeriesReportAffordance() {
  return (
    <section className="series-report">
      <p className="report-lede">
        A missing volume, a wrong date, a duplicate series, or a series we should add? Tell us in
        the MangaDB Discord. It has channels for bug reports, suggestions and series requests, and
        you can attach screenshots or photos of your books.
      </p>
      <a
        className="btn btn-sm report-link"
        href={DISCORD_INVITE_URL}
        target="_blank"
        rel="noreferrer"
      >
        <DiscordIcon />
        Report on Discord
      </a>
    </section>
  );
}
