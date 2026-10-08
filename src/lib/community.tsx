// The MangaDB Discord: the one invite every link uses, and the "Report a
// bug" dialog the workroom header opens. The dialog only writes a context
// block for the person to paste into Discord themselves; nothing here
// joins, posts, or talks to Discord.

import { useRef, useState } from "react";

/** The invite to the MangaDB Discord server. */
export const DISCORD_INVITE_URL = "https://discord.gg/VVcC8a79mz";

/** The Discord logo, sized by its container's CSS and coloured by `currentColor`. */
export function DiscordIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M20.32 4.37a19.8 19.8 0 0 0-4.89-1.52.07.07 0 0 0-.08.04c-.21.38-.44.87-.61 1.25a18.27 18.27 0 0 0-5.49 0 12.64 12.64 0 0 0-.62-1.25.08.08 0 0 0-.08-.04 19.74 19.74 0 0 0-4.89 1.52.07.07 0 0 0-.03.03C.53 9.05-.32 13.58.1 18.06a.08.08 0 0 0 .03.06 19.9 19.9 0 0 0 5.99 3.03.08.08 0 0 0 .08-.03c.46-.63.87-1.3 1.23-1.99a.08.08 0 0 0-.04-.11 13.1 13.1 0 0 1-1.87-.89.08.08 0 0 1-.01-.13l.37-.29a.07.07 0 0 1 .08-.01c3.93 1.79 8.18 1.79 12.06 0a.07.07 0 0 1 .08.01l.37.29a.08.08 0 0 1-.01.13c-.6.35-1.22.65-1.87.89a.08.08 0 0 0-.04.11c.36.7.77 1.36 1.22 1.99a.08.08 0 0 0 .08.03 19.84 19.84 0 0 0 6-3.03.08.08 0 0 0 .03-.06c.5-5.18-.84-9.67-3.55-13.66a.06.06 0 0 0-.03-.03zM8.02 15.33c-1.18 0-2.16-1.08-2.16-2.42 0-1.33.96-2.42 2.16-2.42 1.21 0 2.18 1.1 2.16 2.42 0 1.34-.96 2.42-2.16 2.42zm7.97 0c-1.18 0-2.15-1.08-2.15-2.42 0-1.33.95-2.42 2.15-2.42 1.21 0 2.18 1.1 2.16 2.42 0 1.34-.94 2.42-2.16 2.42z" />
    </svg>
  );
}

/** What a bug report says about where it was filed. Nothing personal. */
export type ReportContext = {
  /** Path, query and hash of the page. */
  page: string;
  /** The viewer's data-team role, or "reader". */
  role: string;
  theme: string;
  viewport: string;
  browser: string;
  time: Date;
};

// Most specific first: Edge and Opera also say Chrome, Chrome also says Safari.
const BROWSERS: ReadonlyArray<[token: string, name: string]> = [
  ["Edg", "Edge"],
  ["OPR", "Opera"],
  ["Firefox", "Firefox"],
  ["Chrome", "Chrome"],
  ["Version", "Safari"],
];
const SYSTEMS: ReadonlyArray<[token: string, name: string]> = [
  ["Android", "Android"],
  ["iPhone", "iOS"],
  ["iPad", "iPadOS"],
  ["CrOS", "ChromeOS"],
  ["Windows", "Windows"],
  ["Mac OS X", "macOS"],
  ["Linux", "Linux"],
];

/** A short "Browser N on OS" from a user agent, or "unknown browser". */
export function browserLabel(userAgent: string): string {
  let browser = "unknown browser";
  for (const [token, name] of BROWSERS) {
    const version = new RegExp(`${token}/(\\d+)`).exec(userAgent)?.[1];
    if (version) {
      browser = `${name} ${version}`;
      break;
    }
  }
  const system = SYSTEMS.find(([token]) => userAgent.includes(token))?.[1];
  return system ? `${browser} on ${system}` : browser;
}

/**
 * The text a bug report starts from: where it happened (with the proposal
 * id when the page is one), then the questions to answer. It always
 * starts with `Page:`.
 */
export function bugReportText(context: ReportContext): string {
  const proposal = /^\/mod\/proposal\/([^/?#]+)/.exec(context.page)?.[1];
  return [
    `Page: ${context.page}`,
    `Role: ${context.role} · Theme: ${context.theme} · Viewport: ${context.viewport}`,
    `Browser: ${context.browser}`,
    `When: ${context.time.toISOString().slice(0, 16).replace("T", " ")} UTC`,
    ...(proposal ? [`Proposal: ${proposal}`] : []),
    "",
    "What happened:",
    "",
    "What I expected:",
    "",
    "Steps to reproduce:",
    "1. ",
  ].join("\n");
}

/** The context of the page the viewer is on now. */
function currentContext(role: string): ReportContext {
  const { pathname, search, hash } = window.location;
  return {
    page: `${pathname}${search}${hash}`,
    role,
    theme: document.documentElement.dataset.theme ?? "dark",
    viewport: `${window.innerWidth}×${window.innerHeight}`,
    browser: browserLabel(navigator.userAgent),
    time: new Date(),
  };
}

/**
 * "Report a bug": a button opening a native dialog with the report text
 * for this page, ready to copy (or select, where the clipboard is not
 * available) and paste into Discord. Escape or Close dismisses it and the
 * browser returns focus to the button.
 */
export function BugReportButton({ role }: { role: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");
  const [status, setStatus] = useState("");

  const open = () => {
    setText(bugReportText(currentContext(role)));
    setStatus("");
    dialog.current?.showModal();
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(field.current?.value ?? text);
      setStatus("Copied");
    } catch {
      field.current?.select();
      setStatus("Selected. Press Ctrl+C (⌘C on a Mac) to copy.");
    }
  };

  return (
    <>
      <button type="button" className="mod-help-link" onClick={open}>
        Report a bug
      </button>
      <dialog ref={dialog} className="bug-report" aria-labelledby="bug-report-title">
        <h2 id="bug-report-title">Report a bug</h2>
        <p>
          Copy this, fill in the three questions, and paste it into the MangaDB Discord's channel
          for bugs and feedback.
        </p>
        <label className="bug-report-label" htmlFor="bug-report-text">
          Report
        </label>
        <textarea
          id="bug-report-text"
          ref={field}
          value={text}
          rows={13}
          onChange={(event) => setText(event.target.value)}
        />
        <div className="bug-actions">
          <button type="button" className="btn btn-sm btn-primary" onClick={() => void copy()}>
            Copy
          </button>
          <a className="btn btn-sm" href={DISCORD_INVITE_URL} target="_blank" rel="noreferrer">
            Open Discord
          </a>
          <span className="bug-status" aria-live="polite">
            {status}
          </span>
          <button
            type="button"
            className="btn btn-sm bug-close"
            onClick={() => dialog.current?.close()}
          >
            Close
          </button>
        </div>
      </dialog>
    </>
  );
}
