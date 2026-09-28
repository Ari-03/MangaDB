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
// - `<ConcealArt>` wraps a Mature Series' page for viewers who have not
//   opted in: every <Cover> inside draws cloth marked 18+ instead of art.

import { useRouter } from "@tanstack/react-router";
import { createIsomorphicFn } from "@tanstack/react-start";
import { getCookie } from "@tanstack/react-start/server";
import { createContext, useContext, useState, type ReactNode } from "react";

const COOKIE = "mangadb-mature";
const YEAR_SECONDS = 60 * 60 * 24 * 365;

/** Whether this viewer opted in to Mature Series, read from the cookie. */
export const showMature = createIsomorphicFn()
  .server(() => getCookie(COOKIE) === "1")
  .client(() => document.cookie.split("; ").includes(`${COOKIE}=1`));

type MatureState = { showMature: boolean; setShowMature: (on: boolean) => void };

const MatureContext = createContext<MatureState>({
  showMature: false,
  setShowMature: () => {},
});

export function MatureProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [on, setOn] = useState(showMature);
  const setShowMature = (next: boolean) => {
    document.cookie = next
      ? `${COOKIE}=1; Path=/; Max-Age=${YEAR_SECONDS}; SameSite=Lax`
      : `${COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
    setOn(next);
    // Every loader read the old choice; reload what is on screen.
    void router.invalidate();
  };
  return (
    <MatureContext.Provider value={{ showMature: on, setShowMature }}>
      {children}
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
 */
export function ConcealArt({ mature, children }: { mature: boolean; children: ReactNode }) {
  const { showMature } = useMature();
  const concealed = mature && !showMature;
  return (
    <ConcealContext.Provider value={concealed}>
      {concealed ? <MatureNotice /> : null}
      {children}
    </ConcealContext.Provider>
  );
}

function MatureNotice() {
  const [asking, setAsking] = useState(false);
  return (
    <div className="container">
      <aside className="mature-notice" role="note">
        <span className="mature-badge" aria-hidden="true">18+</span>
        <p>
          Rated 18+ by the publisher. Covers and listings stay hidden until you choose to see
          mature titles.
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
 * A native <dialog>, opened modal as it mounts.
 */
function AgeConfirm({ onClose }: { onClose: () => void }) {
  const { setShowMature } = useMature();
  return (
    <dialog
      className="age-confirm"
      aria-labelledby="age-confirm-title"
      ref={(el) => {
        if (el && !el.open) el.showModal();
      }}
      onClose={onClose}
    >
      <h2 id="age-confirm-title">Show mature titles?</h2>
      <p>
        Mature titles are rated 18+ by their publishers and can include explicit sexual content
        or extreme violence. They will appear across the catalog, with their covers.
      </p>
      <form method="dialog" className="age-confirm-actions">
        <button className="btn" value="cancel">
          Cancel
        </button>
        <button className="btn btn-primary" value="confirm" onClick={() => setShowMature(true)}>
          I'm 18 or older
        </button>
      </form>
    </dialog>
  );
}

/**
 * The header's switch: shows whether mature titles are on and flips it,
 * asking for the 18+ confirmation on the way on (never on the way off).
 */
export function MatureToggle({ mobile = false }: { mobile?: boolean }) {
  const { showMature: on, setShowMature } = useMature();
  const [asking, setAsking] = useState(false);
  return (
    <>
      <button
        className={mobile ? "nav-link mature-toggle--mobile" : "icon-btn mature-toggle"}
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={mobile ? undefined : "Show mature (18+) titles"}
        title={on ? "Mature titles are shown" : "Mature titles are hidden"}
        onClick={() => (on ? setShowMature(false) : setAsking(true))}
      >
        {mobile ? (on ? "Hide mature titles" : "Show mature titles") : "18+"}
      </button>
      {asking ? <AgeConfirm onClose={() => setAsking(false)} /> : null}
    </>
  );
}
