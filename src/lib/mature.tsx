// The viewer's choice to see Mature Series (convex/lib/mature.ts): titles
// rated 18+ by their publisher, from an adult-only publisher, or so rated
// by the Data Team. Off by default; anyone can turn it on after confirming
// they are 18 or older. The choice lives in a cookie, so the server render
// and every catalog read agree on it: public catalog queries run without
// auth and take it as their `showMature` argument.
//
// - `showMature()` reads the cookie wherever it runs (the request's cookie
//   during SSR, document.cookie in the browser); route loaders pass it on.
// - `<MatureProvider>` holds it for components; `useMature()` reads and
//   changes it. A change rewrites the cookie and reloads every route's data.
// - It is chosen in three places: the welcome question (`<MatureWelcome>`,
//   asked once per browser, only on the Series library and Series pages),
//   Library → Settings (`<MatureSettings>`), and the Series filters
//   (`<MatureFilter>`); plus the notice on a Mature Series' own page.
//   Turning it on always asks for the 18+ confirmation, except in the
//   welcome, which is that question.
// - The home page's shelves always leave Mature Series out
//   (lib/catalogData.ts `fetchHomeCatalog`); the header search still
//   follows the choice.
// - `<ConcealArt>` wraps a Mature Series' page for viewers who have not
//   opted in: every <Cover> inside draws cloth marked 18+ instead of art.

import { useRouter, useRouterState } from "@tanstack/react-router";
import { createIsomorphicFn } from "@tanstack/react-start";
import { getCookie } from "@tanstack/react-start/server";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { track } from "~/lib/analytics";

const COOKIE = "mangadb-mature";
const YEAR_SECONDS = 60 * 60 * 24 * 365;

/**
 * Whether this viewer opted in to Mature Series, read from the cookie:
 * "1" shows them, "0" is an answered no, and no cookie means never asked.
 */
export const showMature = createIsomorphicFn()
  .server(() => getCookie(COOKIE) === "1")
  .client(() => document.cookie.split("; ").includes(`${COOKIE}=1`));

/** Has this browser answered at all? Client-only; the welcome asks until it has. */
const answered = () => document.cookie.split("; ").some((c) => c.startsWith(`${COOKIE}=`));

type MatureState = { showMature: boolean; setShowMature: (on: boolean) => void };

const MatureContext = createContext<MatureState>({
  showMature: false,
  setShowMature: () => {},
});

export function MatureProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [on, setOn] = useState(showMature);
  const setShowMature = (next: boolean) => {
    document.cookie = `${COOKIE}=${next ? 1 : 0}; Path=/; Max-Age=${YEAR_SECONDS}; SameSite=Lax`;
    // A "no" changes nothing on screen; only a "yes" needs fresh data.
    if (next === on) return;
    setOn(next);
    track("mature_titles_toggled", { showMature: next });
    // Every loader read the old choice; reload what is on screen.
    void router.invalidate();
  };
  return (
    <MatureContext.Provider value={{ showMature: on, setShowMature }}>
      {children}
      <MatureWelcome />
    </MatureContext.Provider>
  );
}

export const useMature = () => useContext(MatureContext);

const ConcealContext = createContext(false);

/** True inside a `<ConcealArt>` that is hiding art (read by <Cover>). */
export const useArtConcealed = () => useContext(ConcealContext);

/**
 * A Mature Series' page (or an adult-only publisher's) for this viewer:
 * when they have not opted in, a notice leads and every cover inside is
 * drawn as cloth marked 18+. When they have, the children render untouched.
 * `notice={false}` conceals without the notice, for one cover in a list.
 */
export function ConcealArt({
  mature,
  notice = true,
  children,
}: {
  mature: boolean;
  notice?: boolean;
  children: ReactNode;
}) {
  const { showMature } = useMature();
  const concealed = mature && !showMature;
  return (
    <ConcealContext.Provider value={concealed}>
      {concealed && notice ? <MatureNotice /> : null}
      {children}
    </ConcealContext.Provider>
  );
}

function MatureNotice() {
  const [asking, setAsking] = useState(false);
  return (
    <div className="container">
      <aside className="mature-notice" role="note">
        <span className="mature-badge" aria-hidden="true">
          18+
        </span>
        <p>
          Rated 18+ by the publisher. Covers and listings stay hidden until you choose to see mature
          titles.
        </p>
        <button className="btn btn-sm" type="button" onClick={() => setAsking(true)}>
          Show mature titles
        </button>
      </aside>
      {asking ? <AgeConfirm onClose={() => setAsking(false)} /> : null}
    </div>
  );
}

/**
 * The 18+ confirmation that turning the choice on always goes through.
 * A native <dialog>, opened modal as it mounts, portalled to <body>. The
 * buttons close it themselves rather than through a <form method="dialog">:
 * React bubbles a portal's events through the component tree, so a submit
 * here would reach the Series filters' form, whose handler prevents the
 * default and with it the dialog's own close. Only ever mounted in the
 * browser (on a click); closing it (buttons or Escape) unmounts it.
 */
function AgeConfirm({ onClose }: { onClose: () => void }) {
  const { setShowMature } = useMature();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const close = () => dialogRef.current?.close();
  return createPortal(
    <dialog
      className="age-confirm"
      aria-labelledby="age-confirm-title"
      ref={(el) => {
        dialogRef.current = el;
        if (el && !el.open) el.showModal();
      }}
      onClose={onClose}
    >
      <h2 id="age-confirm-title">Show mature titles?</h2>
      <p>
        Mature titles are rated 18+ by their publishers and can include explicit sexual content or
        extreme violence. They will appear across the catalog, with their covers. The home page's
        shelves still leave them out.
      </p>
      <div className="age-confirm-actions">
        <button className="btn" type="button" onClick={close}>
          Cancel
        </button>
        <button
          className="btn btn-primary"
          type="button"
          onClick={() => {
            setShowMature(true);
            close();
          }}
        >
          I'm 18 or older
        </button>
      </div>
    </dialog>,
    document.body,
  );
}

/**
 * The Mature titles section of Library → Settings (/me): Hidden or Shown,
 * in the same pill as the Sharing defaults. Showing asks for the 18+
 * confirmation first; hiding never asks. The choice is per browser (the
 * cookie), not per account, so it also works signed out from the notice.
 */
export function MatureSettings() {
  const { showMature: on, setShowMature } = useMature();
  const [asking, setAsking] = useState(false);
  return (
    <div className="sharing-settings">
      <p className="sharing-lede">
        Titles rated 18+ by their publishers stay out of browsing, search, and the calendars, and
        their covers are hidden, until you choose to show them. The home page's shelves always leave
        them out. This is saved in this browser.
      </p>
      <div className="vis-field">
        <span className="vis-legend" id="mature-titles-label">
          Mature (18+) titles
        </span>
        <span className="seg-pill" role="radiogroup" aria-labelledby="mature-titles-label">
          {([false, true] as const).map((value) => (
            <label className="seg-opt" key={String(value)}>
              <input
                type="radio"
                name="mature-titles"
                checked={on === value}
                onChange={() => (value ? setAsking(true) : setShowMature(false))}
              />
              <span>{value ? "Shown" : "Hidden"}</span>
            </label>
          ))}
        </span>
        <p className="vis-hint">
          Includes explicit sexual content and extreme violence. You must be 18 or older.
        </p>
      </div>
      {asking ? <AgeConfirm onClose={() => setAsking(false)} /> : null}
    </div>
  );
}

/**
 * The Mature content group of the Series filters, under Format: the same
 * chips as the other groups, but a site-wide choice, not a URL filter.
 */
export function MatureFilter() {
  const { showMature: on, setShowMature } = useMature();
  const [asking, setAsking] = useState(false);
  return (
    <fieldset className="filter-group">
      <legend className="filter-legend">Mature content</legend>
      <div className="choice-row">
        {([false, true] as const).map((value) => (
          <label key={String(value)} className="choice">
            <input
              type="radio"
              name="mature"
              checked={on === value}
              onChange={() => (value ? setAsking(true) : setShowMature(false))}
            />
            <span>{value ? "Allow" : "Hide"}</span>
          </label>
        ))}
      </div>
      <p className="filter-hint">
        Titles rated 18+ by their publishers. Applies across the site, except the home page's
        shelves, which always leave them out.
      </p>
      {asking ? <AgeConfirm onClose={() => setAsking(false)} /> : null}
    </fieldset>
  );
}

/** Where the welcome may open: the Series library and every Series page. */
const WELCOME_PATHS = /^\/series(\/|$)/;

/**
 * Asked once per browser, the first time the viewer reaches the Series
 * library or a Series page: allow mature content or keep it hidden.
 * Elsewhere it never asks, and the home page's shelves leave Mature Series
 * out whatever the answer. Either answer (or dismissing it) is remembered,
 * and either can be changed later in Settings or the Series filters.
 * Opened after hydration, so the server render never depends on it.
 */
function MatureWelcome() {
  const { setShowMature } = useMature();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (WELCOME_PATHS.test(pathname) && !answered()) setOpen(true);
  }, [pathname]);
  if (!open) return null;
  const answer = (allow: boolean) => {
    setShowMature(allow);
    setOpen(false);
  };
  return (
    <dialog
      className="age-confirm"
      aria-labelledby="mature-welcome-title"
      ref={(el) => {
        if (el && !el.open) el.showModal();
      }}
      // Escape counts as "keep it hidden", so it does not ask again.
      onClose={() => (answered() ? setOpen(false) : answer(false))}
    >
      <h2 id="mature-welcome-title">Allow mature content?</h2>
      <p>
        Some manga are rated 18+ by their publishers, from graphic violence to explicit sexual
        content. They are hidden unless you allow them. You can change this any time in the Series
        filters or your settings.
      </p>
      <div className="age-confirm-actions">
        <button className="btn" type="button" onClick={() => answer(false)}>
          Keep hidden
        </button>
        <button className="btn btn-primary" type="button" onClick={() => answer(true)}>
          I'm 18+, allow
        </button>
      </div>
    </dialog>
  );
}
