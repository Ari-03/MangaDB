// The Publishers board (`/publishers`, `/publishers/{yyyy-mm}`): what each
// Publisher is releasing in one month, busiest first, then the A–Z directory
// of every active Publisher. The month window is the Releases browser's
// (convex/publisher.ts monthBoard groups it by Publisher), so every card
// hands off to the browser pre-filtered to that Publisher and month, and to
// the Publisher Spotlight for the profile.
//
// Month URLs mirror the browser (lib/month.ts): the current month is the bare
// `/publishers`, every other month `/publishers/{yyyy-mm}`.

import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { Cover } from "~/lib/cover";
import {
  addMonths,
  MONTH_NAMES,
  monthParam,
  monthTitle,
  sameMonth,
  type YearMonth,
} from "~/lib/month";
import { slugParams } from "~/lib/slug";
import type { PublishersBoardData } from "~/server/publisher";

type BoardCard = PublishersBoardData["board"][number];
type DirectoryEntry = PublishersBoardData["directory"][number];

const shortMonth = (ym: YearMonth) => MONTH_NAMES[ym.month - 1]!.slice(0, 3);

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

/**
 * A link to one month of the board: the bare `/publishers` for the current
 * month (its canonical home), `/publishers/{yyyy-mm}` for any other.
 */
function MonthLink({
  month,
  today,
  className,
  label,
  children,
}: {
  month: YearMonth;
  today: YearMonth;
  className?: string;
  /** Accessible name, for links whose text is only an arrow. */
  label?: string;
  children: ReactNode;
}) {
  return sameMonth(month, today) ? (
    <Link className={className} to="/publishers" aria-label={label}>
      {children}
    </Link>
  ) : (
    <Link
      className={className}
      to="/publishers/$month"
      params={{ month: monthParam(month) }}
      aria-label={label}
    >
      {children}
    </Link>
  );
}

/** Months either side of the shown one in the strip. */
const STRIP_REACH = 3;

/**
 * The page's one month control: ‹ a run of months centred on the shown one ›.
 * Today's month carries a "now" mark; once the reader has paged far enough
 * that it leaves the strip, a "Back to …" link returns to it. Each month's
 * distance from the centre rides along so narrow screens can drop the ends.
 */
function MonthStrip({ anchor, today }: { anchor: YearMonth; today: YearMonth }) {
  const prev = addMonths(anchor, -1);
  const next = addMonths(anchor, 1);
  const months = Array.from({ length: STRIP_REACH * 2 + 1 }, (_, i) =>
    addMonths(anchor, i - STRIP_REACH),
  );
  const todayInStrip = months.some((month) => sameMonth(month, today));
  return (
    <nav className="month-strip" aria-label="Month">
      <MonthLink month={prev} today={today} className="month-step" label={`Previous month, ${monthTitle(prev)}`}>
        ‹
      </MonthLink>
      <ol className="month-strip-list">
        {months.map((month, i) => {
          const isNow = sameMonth(month, today);
          const text = (
            <>
              {shortMonth(month)}
              {month.year !== anchor.year ? (
                <span className="month-strip-year">{month.year}</span>
              ) : null}
              {isNow ? <span className="month-strip-now">now</span> : null}
            </>
          );
          return (
            <li key={monthParam(month)} data-reach={Math.abs(i - STRIP_REACH)}>
              {sameMonth(month, anchor) ? (
                <span className="month-strip-item is-on" aria-current="page">
                  {text}
                </span>
              ) : (
                <MonthLink month={month} today={today} className="month-strip-item" label={monthTitle(month)}>
                  {text}
                </MonthLink>
              )}
            </li>
          );
        })}
      </ol>
      <MonthLink month={next} today={today} className="month-step" label={`Next month, ${monthTitle(next)}`}>
        ›
      </MonthLink>
      {todayInStrip ? null : (
        <MonthLink month={today} today={today} className="month-strip-back">
          Back to {monthTitle(today)}
        </MonthLink>
      )}
    </nav>
  );
}

/**
 * The whole page for one month. `anchor` is the month shown, `today` the
 * current month (UTC, from the loader so SSR and hydration agree); `data` is
 * null when Convex is not configured.
 */
export function PublishersBoard({
  anchor,
  today,
  data,
}: {
  anchor: YearMonth;
  today: YearMonth;
  data: PublishersBoardData | null;
}) {
  const board = data?.board ?? [];
  const totalReleases = board.reduce((n, card) => n + card.releases, 0);
  const totalNew = board.reduce((n, card) => n + card.newSeries, 0);

  return (
    <main className="publishers-page">
      <div className="page-head">
        <div>
          <p className="page-kicker">English manga publishers</p>
          <h1 className="page-title">{monthTitle(anchor)}</h1>
        </div>
      </div>

      <div className="toolbar">
        <MonthStrip anchor={anchor} today={today} />
        {board.length > 0 ? (
          <p className="result-count">
            {plural(board.length, "publisher")} ·{" "}
            {plural(totalReleases, "release")} ·{" "}
            {plural(totalNew, "new series", "new series")}
          </p>
        ) : null}
      </div>

      {data === null ? (
        <p className="notice">
          Convex is not configured. Set <code>VITE_CONVEX_URL</code> (see the
          README) and restart to see what publishers are releasing.
        </p>
      ) : board.length === 0 ? (
        <p className="notice">
          No publisher has releases on file for {monthTitle(anchor)}.
          {sameMonth(anchor, today) ? null : (
            <>
              {" "}
              <MonthLink month={today} today={today}>
                See this month
              </MonthLink>
              .
            </>
          )}
        </p>
      ) : (
        <section aria-labelledby="board-title">
          <h2 id="board-title" className="visually-hidden">
            Publishers releasing in {monthTitle(anchor)}
          </h2>
          <ol className="pub-board">
            {board.map((card) => (
              <BoardCardItem key={card.publisher.slug} card={card} anchor={anchor} />
            ))}
          </ol>
        </section>
      )}

      {data ? <Directory directory={data.directory} anchor={anchor} /> : null}
    </main>
  );
}

/** "+5 vs Aug" — the month-over-month change in release count. */
function Delta({ card, anchor }: { card: BoardCard; anchor: YearMonth }) {
  const prev = addMonths(anchor, -1);
  const diff = card.releases - card.previousReleases;
  return (
    <span
      className={`pub-delta ${diff > 0 ? "is-up" : diff < 0 ? "is-down" : ""}`}
      title={`${plural(card.previousReleases, "release")} in ${monthTitle(prev)}`}
    >
      {diff === 0
        ? `Same as ${shortMonth(prev)}`
        : `${diff > 0 ? "+" : "−"}${Math.abs(diff)} vs ${shortMonth(prev)}`}
    </span>
  );
}

/**
 * One Publisher's month: name (to the Spotlight), release count, Format
 * split, new vs continuing Series, the delta, a strip of covers, and the
 * hand-off into the Releases browser filtered to this Publisher and month.
 */
function BoardCardItem({ card, anchor }: { card: BoardCard; anchor: YearMonth }) {
  const { publisher } = card;
  const continuing = card.series - card.newSeries;
  return (
    <li className="pub-card" id={`pub-${publisher.slug}`}>
      <div className="pub-card-head">
        <div className="pub-card-id">
          <h3 className="pub-card-name">
            <Link to="/publisher/$slug" params={{ slug: publisher.slug }}>
              {publisher.name}
            </Link>
          </h3>
          {publisher.parent ? (
            <p className="pub-card-parent">
              Imprint of{" "}
              <Link to="/publisher/$slug" params={{ slug: publisher.parent.slug }}>
                {publisher.parent.name}
              </Link>
            </p>
          ) : null}
        </div>
        <p className="pub-card-count">
          <span className="pub-card-num">{card.releases}</span>
          {card.releases === 1 ? "release" : "releases"}
        </p>
      </div>

      <p className="pub-card-facts">
        {card.physical > 0 ? (
          <span className="chip chip--physical">{card.physical} physical</span>
        ) : null}
        {card.digital > 0 ? (
          <span className="chip chip--digital">{card.digital} digital</span>
        ) : null}
        {card.newSeries > 0 ? (
          <span
            className="chip chip--new"
            title="Series whose first volume comes out this month"
          >
            {card.newSeries} new series
          </span>
        ) : null}
        {continuing > 0 ? (
          <span className="chip">{continuing} continuing</span>
        ) : null}
        <Delta card={card} anchor={anchor} />
      </p>

      <div className="pub-card-shelf">
        {card.covers.map((release) => {
          const title = `${release.series.map((s) => s.title).join(" × ")} ${release.volumeLabel}`.trim();
          return (
            <Link
              key={release.id}
              className="cover-link"
              to="/edition/$publicId/$slug"
              params={slugParams(release.edition.publicId, release.edition.title)}
              hash={release.anchor}
              title={title}
            >
              <Cover
                src={release.coverUrl}
                isbn13={release.coverIsbn}
                title={title}
                foot={[release.volumeLabel, publisher.name]}
              />
            </Link>
          );
        })}
      </div>

      <Link
        className="section-link pub-card-more"
        to="/releases/$month"
        params={{ month: monthParam(anchor) }}
        search={{ publisher: publisher.slug }}
        rel="nofollow"
      >
        {card.releases > card.covers.length
          ? `All ${card.releases} in the release calendar →`
          : "See them in the release calendar →"}
      </Link>
    </li>
  );
}

/**
 * Every active Publisher A–Z, imprints nested under their parent company.
 * Quiet Publishers are listed too; active ones link to their card above.
 */
function Directory({
  directory,
  anchor,
}: {
  directory: PublishersBoardData["directory"];
  anchor: YearMonth;
}) {
  const total = directory.reduce((n, entry) => n + 1 + entry.imprints.length, 0);
  return (
    <section className="section pub-directory" aria-labelledby="directory-title">
      <div className="section-head">
        <h2 id="directory-title" className="section-title">
          All publishers
        </h2>
        <p className="section-note">
          {total} publishers, A–Z. Imprints sit under their parent company.
        </p>
      </div>
      <ul className="pub-dir">
        {directory.map((entry) => (
          <li key={entry.slug} className="pub-dir-item">
            <DirectoryLine entry={entry} anchor={anchor} />
            {entry.imprints.length > 0 ? (
              <ul className="pub-dir-imprints" aria-label={`${entry.name} imprints`}>
                {entry.imprints.map((imprint) => (
                  <li key={imprint.slug}>
                    <DirectoryLine entry={imprint} anchor={anchor} />
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function DirectoryLine({
  entry,
  anchor,
}: {
  entry: Omit<DirectoryEntry, "imprints">;
  anchor: YearMonth;
}) {
  return (
    <span className="pub-dir-line">
      <Link
        className="pub-dir-name"
        to="/publisher/$slug"
        params={{ slug: entry.slug }}
      >
        {entry.name}
      </Link>
      {entry.defunct ? <span className="chip pub-dir-defunct">Defunct</span> : null}
      {entry.releases > 0 ? (
        <a className="pub-dir-count" href={`#pub-${entry.slug}`}>
          {entry.releases} in {shortMonth(anchor)}
        </a>
      ) : null}
    </span>
  );
}
