// The per-Series "see something missing/wrong? → report" affordance
// (ticket #40, spec §7). Renders on every Series page — partially imported
// Series show publicly as-is, and this is their correction on-ramp into the
// proposal queue. The closed state is static (SSR renders it identically
// for everyone); opening it reveals the report form signed in, or a sign-in
// pointer signed out.

import { ConvexError } from "convex/values";
import { useMutation, useQuery } from "convex/react";
import { useState } from "react";

import { api } from "../../convex/_generated/api";
import { convexClient } from "~/providers";

function errorMessage(err: unknown): string {
  if (err instanceof ConvexError && typeof err.data === "object" && err.data !== null) {
    const message = (err.data as { message?: string }).message;
    if (message) return message;
  }
  return "That didn't go through. Try again.";
}

export function SeriesReportAffordance({
  seriesPublicId,
}: {
  seriesPublicId: number;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className="series-report">
      {open ? (
        convexClient ? (
          <ReportForm seriesPublicId={seriesPublicId} onDone={() => setOpen(false)} />
        ) : (
          <p className="notice">
            Reporting needs a configured Convex deployment (see the README).
          </p>
        )
      ) : (
        <button
          type="button"
          className="report-toggle"
          onClick={() => setOpen(true)}
        >
          See something missing or wrong? Report it
        </button>
      )}
    </section>
  );
}

function ReportForm({
  seriesPublicId,
  onDone,
}: {
  seriesPublicId: number;
  onDone: () => void;
}) {
  const viewer = useQuery(api.users.viewer, {});
  const submit = useMutation(api.reports.submit);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  if (viewer === undefined) return <p className="notice">One moment…</p>;
  if (viewer === null) {
    return (
      <p className="notice">
        <a href="/sign-in">Sign in</a> to report a missing volume, a wrong
        date, or anything else off about this series.
      </p>
    );
  }
  if (viewer.needsUsername) {
    return (
      <p className="notice">
        <a href="/claim-username">Claim a username</a> to send reports.
      </p>
    );
  }
  if (sent) {
    return (
      <p className="notice">
        Thanks — your report is in the review queue. The data team will take a
        look.
      </p>
    );
  }
  return (
    <form
      className="report-form"
      onSubmit={(event) => {
        event.preventDefault();
        setError(null);
        submit({ seriesPublicId, message })
          .then(() => setSent(true))
          .catch((err: unknown) => setError(errorMessage(err)));
      }}
    >
      <label>
        What's missing or wrong?
        <textarea
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          rows={3}
          maxLength={2000}
          placeholder="A missing volume, a wrong release date, a duplicate series…"
          required
        />
      </label>
      {error ? <p className="form-error">{error}</p> : null}
      <div className="report-actions">
        <button type="submit" disabled={message.trim() === ""}>
          Send report
        </button>
        <button type="button" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}
