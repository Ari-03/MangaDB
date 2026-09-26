// Search as you type (ticket #38 follow-up): the header search box as a
// combobox that offers live suggestions from `api.catalog.suggest` — Series
// with their jackets, "Did you mean" near misses for typos, Publishers, and
// a last row into the full /search page. Needs the reactive Convex client;
// providers.tsx falls back to the plain GET form without one.

import { useNavigate } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import {
  useEffect,
  useId,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";

import { api } from "../../convex/_generated/api";
import { Cover } from "~/lib/cover";
import { normalizeIsbn } from "~/lib/isbn";
import { seriesPath } from "~/lib/slug";

type Suggestions = FunctionReturnType<typeof api.catalog.suggest>;
type SeriesCard = Suggestions["series"][number];

type Option =
  | { kind: "series"; href: string; card: SeriesCard }
  | { kind: "publisher"; href: string; name: string }
  | { kind: "isbn"; href: string; isbn: string }
  | { kind: "all"; href: string; query: string };

/** `stale` rows answer an earlier query: dimmed, and never highlighted. */
type Group = { label: string | null; options: Option[]; stale: boolean };

/** Characters typed before suggestions are fetched. */
const MIN_QUERY = 2;
/** Quiet time before a keystroke becomes a query. */
const SUGGEST_DEBOUNCE_MS = 180;

/**
 * True for input that is an ISBN being typed (digits, hyphens, X; five
 * digits or more). Neither search box acts on it until Enter: title
 * suggestions for digits are noise, and the /search loader redirects any
 * valid ISBN — which a half-typed ISBN-13 can briefly be as an ISBN-10.
 */
export function isbnInProgress(query: string): boolean {
  return /^[0-9Xx\s-]+$/.test(query) && query.replace(/[^0-9]/g, "").length >= 5;
}

/**
 * `value` once it has stopped changing for `ms` — the search inputs query
 * (or navigate) on this instead of on every keystroke.
 */
export function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/**
 * The dropdown's rows, grouped: near misses first when the query looks like
 * a typo, then Series, then Publishers, and always a row into /search. A
 * valid ISBN offers only the jump to that book. `stale` marks `data` as the
 * answer to an earlier query.
 */
function suggestionGroups(query: string, data: Suggestions | null, stale: boolean): Group[] {
  const isbn = normalizeIsbn(query);
  if (isbn) {
    return [{ label: null, options: [{ kind: "isbn", href: `/isbn/${isbn}`, isbn }], stale: false }];
  }
  const seriesOption = (card: SeriesCard): Option => ({
    kind: "series",
    href: seriesPath(card.publicId, card.title),
    card,
  });
  const groups: Group[] = [
    { label: "Did you mean", options: (data?.didYouMean ?? []).map(seriesOption), stale },
    { label: "Series", options: (data?.series ?? []).map(seriesOption), stale },
    {
      label: "Publishers",
      options: (data?.publishers ?? []).map((p) => ({
        kind: "publisher" as const,
        href: `/publisher/${p.slug}`,
        name: p.name,
      })),
      stale,
    },
    {
      label: null,
      options: [{ kind: "all", href: `/search?q=${encodeURIComponent(query)}`, query }],
      stale: false,
    },
  ];
  return groups.filter((group) => group.options.length > 0);
}

/** A suggested Series' second line: the alt title it matched, size, publisher. */
function seriesMeta(card: SeriesCard): string {
  return [
    card.altMatch ? `“${card.altMatch}”` : null,
    card.volumeCount ? `${card.volumeCount} ${card.volumeCount === 1 ? "vol" : "vols"}` : null,
    card.publisher,
  ]
    .filter(Boolean)
    .join(" · ");
}

function OptionBody({ option }: { option: Option }) {
  switch (option.kind) {
    case "series":
      return (
        <>
          <span className="suggest-thumb" aria-hidden="true">
            <Cover
              src={option.card.coverUrl}
              isbn13={option.card.coverIsbn}
              title={option.card.title}
              lazy={false}
            />
          </span>
          <span className="suggest-text">
            <span className="suggest-title">{option.card.title}</span>
            <span className="suggest-meta">{seriesMeta(option.card)}</span>
          </span>
        </>
      );
    case "publisher":
      return (
        <>
          <span className="suggest-thumb suggest-mark" aria-hidden="true">
            {option.name.slice(0, 1)}
          </span>
          <span className="suggest-text">
            <span className="suggest-title">{option.name}</span>
            <span className="suggest-meta">Publisher</span>
          </span>
        </>
      );
    case "isbn":
      return <span className="suggest-all">Look up ISBN {option.isbn} →</span>;
    case "all":
      return <span className="suggest-all">See all results for “{option.query}” →</span>;
  }
}

/**
 * The live header search (desktop bar and mobile drawer): still a real GET
 * form to /search, so Enter with nothing highlighted — and any ISBN — goes
 * through the /search route exactly as before. While typing, a debounced
 * `catalog.suggest` subscription fills an ARIA combobox listbox: ArrowUp/
 * ArrowDown move the highlight, Enter opens it, Escape or leaving the box
 * closes it. Any edit clears the highlight, and rows still answering an
 * earlier query stay in view dimmed but can't be highlighted, so Enter
 * never opens a result for text no longer in the box. `onNavigate` runs
 * after any navigation (the drawer closes).
 */
export function SearchCombobox({
  mobile = false,
  onNavigate,
}: {
  mobile?: boolean;
  onNavigate?: () => void;
}) {
  const navigate = useNavigate();
  const listId = useId();
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  // The highlighted row, by href, so it stays on the same row as answers
  // arrive and reorder the list.
  const [active, setActive] = useState<string | null>(null);

  const query = text.trim();
  const debounced = useDebounced(query, SUGGEST_DEBOUNCE_MS);
  const live = useQuery(
    api.catalog.suggest,
    debounced.length >= MIN_QUERY && !isbnInProgress(debounced) ? { query: debounced } : "skip",
  );
  // useQuery only ever answers the current query, so an older response can
  // never land over a newer one; holding the last answer (and the query it
  // answers) while the next is in flight keeps the list updating in place
  // instead of flashing empty.
  const [shown, setShown] = useState<{ query: string; data: Suggestions } | null>(null);
  useEffect(() => {
    if (live !== undefined) setShown({ query: debounced, data: live });
  }, [live, debounced]);
  const stale = shown !== null && shown.query !== query;

  const groups =
    query.length >= MIN_QUERY
      ? suggestionGroups(query, isbnInProgress(query) ? null : (shown?.data ?? null), stale)
      : [];
  const options = groups.flatMap((group) => group.options);
  // The rows the keyboard and pointer can highlight, in list order.
  const reachable = groups.flatMap((group) => (group.stale ? [] : group.options));
  const expanded = open && options.length > 0;
  // Rows can vanish under the highlight when an answer arrives.
  const at = reachable.findIndex((option) => option.href === active);
  const highlighted = reachable[at];
  const optionId = (index: number) => `${listId}-${index}`;

  const close = () => {
    setOpen(false);
    setActive(null);
  };

  const follow = (option: Option) => {
    close();
    if (option.kind === "all") {
      void navigate({ to: "/search", search: { q: option.query } });
    } else {
      setText("");
      setShown(null);
      void navigate({ href: option.href });
    }
    onNavigate?.();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp": {
        if (options.length === 0) return;
        event.preventDefault();
        if (!open) {
          setOpen(true);
          return;
        }
        // Positions 1..n are the reachable rows, 0 is "back in the input".
        const step = event.key === "ArrowDown" ? 1 : -1;
        const slots = reachable.length + 1;
        setActive(reachable[((at + 1 + step + slots) % slots) - 1]?.href ?? null);
        return;
      }
      case "Enter": {
        const option = expanded ? highlighted : undefined;
        if (option) {
          event.preventDefault();
          follow(option);
        }
        return;
      }
      case "Escape":
        if (expanded) {
          event.preventDefault();
          close();
        }
        return;
    }
  };

  // Plain left clicks navigate in-app; modified clicks keep the browser's
  // new-tab behaviour through the real href.
  const onOptionClick = (event: MouseEvent<HTMLAnchorElement>, option: Option) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    follow(option);
  };

  // Each group's first row index in the flat, keyboard-navigable list.
  let offset = 0;
  const placed = groups.map((group) => {
    const start = offset;
    offset += group.options.length;
    return { ...group, start };
  });

  return (
    <form
      className={mobile ? "search search--mobile" : "search"}
      role="search"
      action="/search"
      method="get"
      onSubmit={(event) => {
        event.preventDefault();
        close();
        void navigate({ to: "/search", search: { q: text } });
        onNavigate?.();
      }}
    >
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
        <circle cx="7.2" cy="7.2" r="4.4" />
        <path d="m10.6 10.6 3 3" />
      </svg>
      <input
        className="search-input"
        type="search"
        name="q"
        placeholder="Search series, publishers, ISBN"
        aria-label="Search series, publishers, or an ISBN"
        autoComplete="off"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={listId}
        aria-activedescendant={expanded && highlighted ? optionId(options.indexOf(highlighted)) : undefined}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          if (event.target.value.trim().length < MIN_QUERY) setShown(null);
          setOpen(true);
          setActive(null);
        }}
        onFocus={() => setOpen(true)}
        onBlur={close}
        onKeyDown={onKeyDown}
      />
      <div
        className="suggest"
        id={listId}
        role="listbox"
        aria-label="Search suggestions"
        aria-busy={stale}
        hidden={!expanded}
      >
        {placed.map((group) => {
          const rows = group.options.map((option, i) => {
            const at = group.start + i;
            return (
              <a
                key={option.href}
                id={optionId(at)}
                role="option"
                aria-selected={option === highlighted}
                className={option.kind === "all" || option.kind === "isbn" ? "suggest-row suggest-row--all" : "suggest-row"}
                href={option.href}
                tabIndex={-1}
                // Keep focus in the input so the list doesn't close mid-click.
                onMouseDown={(event) => event.preventDefault()}
                onMouseMove={() => {
                  if (!group.stale) setActive(option.href);
                }}
                onClick={(event) => onOptionClick(event, option)}
              >
                <OptionBody option={option} />
              </a>
            );
          });
          if (group.label === null) return rows;
          const headId = `${listId}-${group.label.replace(/ /g, "-")}`;
          return (
            <div
              key={group.label}
              role="group"
              aria-labelledby={headId}
              className={group.stale ? "suggest-stale" : undefined}
            >
              <div className="suggest-head" id={headId}>
                {group.label}
              </div>
              {rows}
            </div>
          );
        })}
      </div>
    </form>
  );
}
