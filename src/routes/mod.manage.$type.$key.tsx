import { createFileRoute, Link } from "@tanstack/react-router";
import { ConvexError } from "convex/values";
import { useMutation, useQuery } from "convex/react";
import { useState } from "react";

import { api } from "../../convex/_generated/api";
import type { FunctionReturnType } from "convex/server";
import {
  EDITABLE_FIELDS,
  type RecordType,
} from "../../convex/lib/moderationFields";
import { useIsModerator } from "~/lib/moderation";
import { convexClient } from "~/providers";

/**
 * The sensitive-operations panel (ticket #33, spec §5): Hide, Restore,
 * Merge, Split, and temporary Locks for one record. Every operation shows
 * the impact preview, demands a written reason, and requires an explicit
 * confirmation checkbox before its button enables — the mutations enforce
 * all three again server-side. Moderators/Administrators only; never
 * indexed.
 */
export const Route = createFileRoute("/mod/manage/$type/$key")({
  head: () => ({
    meta: [
      { title: "Manage record — MangaDB" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: ModManagePage,
});

function isRecordType(raw: string): raw is RecordType {
  return raw in EDITABLE_FIELDS;
}

function ModManagePage() {
  const { type, key } = Route.useParams();

  if (!convexClient) {
    return (
      <main>
        <p className="notice">
          Moderation needs a configured Convex deployment (see the README).
        </p>
      </main>
    );
  }
  if (!isRecordType(type)) {
    return (
      <main>
        <h1>Unknown record type</h1>
        <p className="notice">
          Nothing manageable lives at this address. <Link to="/">Go home</Link>.
        </p>
      </main>
    );
  }
  return <ModManageGate type={type} manageKey={key} />;
}

function ModManageGate({
  type,
  manageKey,
}: {
  type: RecordType;
  manageKey: string;
}) {
  const isModerator = useIsModerator();
  const viewer = useQuery(api.users.viewer, {});
  if (viewer === undefined) {
    return (
      <main>
        <p className="notice">Checking your access…</p>
      </main>
    );
  }
  if (!isModerator) {
    return (
      <main>
        <h1>Moderators only</h1>
        <p className="notice">
          Sensitive catalog operations are for Moderators and Administrators.{" "}
          {viewer === null ? <a href="/sign-in">Sign in</a> : null}
        </p>
      </main>
    );
  }
  return <ModManagePanel type={type} manageKey={manageKey} />;
}

type ManageForm = NonNullable<FunctionReturnType<typeof api.sensitiveOps.manageForm>>;

function errorMessage(err: unknown): string {
  return err instanceof ConvexError &&
    typeof err.data === "object" &&
    err.data !== null
    ? String((err.data as { message?: string }).message ?? "The operation failed.")
    : err instanceof ConvexError
      ? String(err.data)
      : "The operation failed. Nothing was changed — try again.";
}

/** The impact preview every operation must show before confirmation. */
function ImpactPreview({ impact, title }: { impact: ManageForm["impact"]; title: string }) {
  return (
    <div className="impact-preview">
      <h3>Impact preview: {title}</h3>
      <ul>
        {impact.map((row) => (
          <li key={row.label}>
            {row.label}: <strong>{row.count}</strong>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * One operation's form: required reason, explicit confirmation checkbox
 * (asserting the impact preview above was reviewed), and the action button.
 */
function ActionForm({
  heading,
  hint,
  buttonLabel,
  onSubmit,
}: {
  heading: string;
  hint: string;
  buttonLabel: string;
  onSubmit: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  return (
    <section className="manage-action">
      <h2>{heading}</h2>
      <p className="section-hint">{hint}</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          setError(null);
          onSubmit(reason)
            .then(() => {
              setDone(true);
              setReason("");
              setConfirmed(false);
            })
            .catch((err: unknown) => setError(errorMessage(err)))
            .finally(() => setBusy(false));
        }}
      >
        <label>
          Reason (required, recorded in the public history)
          <textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            rows={2}
            placeholder="Why is this operation correct?"
            required
          />
        </label>
        <label className="manage-confirm">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
          />{" "}
          I reviewed the impact preview and want to proceed.
        </label>
        <div>
          <button
            type="submit"
            disabled={busy || reason.trim() === "" || !confirmed}
          >
            {busy ? "Working…" : buttonLabel}
          </button>
        </div>
        {error ? <p className="form-error">{error}</p> : null}
        {done ? <p className="notice">Done — the operation was recorded.</p> : null}
      </form>
    </section>
  );
}

/** Merge needs a second record: resolve + preview the survivor, then act. */
function MergeSection({
  type,
  form,
}: {
  type: RecordType;
  form: ManageForm;
}) {
  const [keyInput, setKeyInput] = useState("");
  const [survivorKey, setSurvivorKey] = useState<string | null>(null);
  const survivor = useQuery(
    api.sensitiveOps.manageForm,
    survivorKey !== null ? { type, key: survivorKey } : "skip",
  );
  const mergeRecords = useMutation(api.sensitiveOps.mergeRecords);

  const keyHint =
    type === "publisher"
      ? "the survivor's slug"
      : type === "series" || type === "volume" || type === "edition" || type === "releaseBundle"
        ? "the survivor's public ID"
        : "the survivor's document ID";

  return (
    <section className="manage-action">
      <h2>Merge into a survivor</h2>
      <p className="section-hint">
        This record becomes the merge loser: its observations, compatible
        relationships, and user tracking transfer to the survivor, and its
        URLs 301 there permanently. Only an explicit Split reverses a merge.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setSurvivorKey(keyInput.trim());
        }}
      >
        <label>
          Survivor ({keyHint})
          <input
            type="text"
            value={keyInput}
            onChange={(event) => setKeyInput(event.target.value)}
          />
        </label>
        <button type="submit" disabled={keyInput.trim() === ""}>
          Preview survivor
        </button>
      </form>
      {survivorKey === null ? null : survivor === undefined ? (
        <p className="notice">Loading survivor…</p>
      ) : survivor === null ? (
        <p className="form-error">No {type} matches "{survivorKey}".</p>
      ) : survivor.ref.id === form.ref.id ? (
        <p className="form-error">A record cannot merge into itself.</p>
      ) : survivor.status !== "active" || survivor.locked ? (
        <p className="form-error">
          The survivor must be active and unlocked; "{survivor.title}" is{" "}
          {survivor.locked ? "locked" : survivor.status}.
        </p>
      ) : (
        <>
          <ImpactPreview impact={survivor.impact} title={`survivor "${survivor.title}"`} />
          <ActionForm
            heading={`Confirm merge into "${survivor.title}"`}
            hint="Transfers everything to the survivor and marks this record Merged."
            buttonLabel="Merge"
            onSubmit={async (reason) => {
              await mergeRecords({
                survivor: survivor.ref as never,
                loser: form.ref as never,
                reason,
                confirmImpact: true,
              });
            }}
          />
        </>
      )}
    </section>
  );
}

function ModManagePanel({
  type,
  manageKey,
}: {
  type: RecordType;
  manageKey: string;
}) {
  const form = useQuery(api.sensitiveOps.manageForm, { type, key: manageKey });
  const hideRecord = useMutation(api.sensitiveOps.hideRecord);
  const restoreRecord = useMutation(api.sensitiveOps.restoreRecord);
  const lockRecord = useMutation(api.sensitiveOps.lockRecord);
  const unlockRecord = useMutation(api.sensitiveOps.unlockRecord);
  const splitRecord = useMutation(api.sensitiveOps.splitRecord);

  if (form === undefined) {
    return (
      <main>
        <p className="notice">Loading…</p>
      </main>
    );
  }
  if (form === null) {
    return (
      <main>
        <h1>Record not found</h1>
        <p className="notice">
          No {type} matches this address. <Link to="/">Go home</Link>.
        </p>
      </main>
    );
  }

  const singleRefOp =
    (mutate: typeof hideRecord) => async (reason: string) => {
      await mutate({ ref: form.ref as never, reason, confirmImpact: true });
    };

  return (
    <main className="mod-manage-page">
      <nav className="breadcrumbs" aria-label="Breadcrumb">
        <Link to="/">MangaDB</Link> <span aria-hidden="true">/</span>{" "}
        <span>Manage</span>
      </nav>
      <h1>Manage: {form.title}</h1>
      <p className="section-hint">
        Sensitive catalog operations (hide, restore, merge, split, locks).
        Each one requires a reason, the impact preview below, and explicit
        confirmation; all of it lands in the record's public history.
      </p>
      <p className="manage-status">
        Status: <strong>{form.status}</strong>
        {form.locked ? (
          <>
            {" "}
            · <strong>temporarily locked</strong>
          </>
        ) : null}
        {form.mergedInto ? <> · merged into "{form.mergedInto.title}"</> : null}
      </p>

      <ImpactPreview impact={form.impact} title={`"${form.title}"`} />

      {form.status === "active" && !form.locked ? (
        <>
          <ActionForm
            heading="Hide"
            hint="Removes this record from public discovery while preserving its identity, history, and every tracking reference. Hidden records reject ordinary edits until restored."
            buttonLabel="Hide record"
            onSubmit={singleRefOp(hideRecord)}
          />
          <ActionForm
            heading="Lock temporarily"
            hint="Freezes ordinary edits while a dispute is worked out. Sensitive operations stay available to Moderators after an explicit unlock."
            buttonLabel="Lock record"
            onSubmit={singleRefOp(lockRecord)}
          />
          <MergeSection type={type} form={form} />
        </>
      ) : null}

      {form.status === "active" && form.locked ? (
        <ActionForm
          heading="Unlock"
          hint="Lifts the temporary lock; ordinary edits resume."
          buttonLabel="Unlock record"
          onSubmit={singleRefOp(unlockRecord)}
        />
      ) : null}

      {form.status === "hidden" ? (
        <ActionForm
          heading="Restore"
          hint="Reactivates this hidden record; identity, history, and tracking references were preserved while it was hidden."
          buttonLabel="Restore record"
          onSubmit={singleRefOp(restoreRecord)}
        />
      ) : null}

      {form.status === "merged" ? (
        form.splitAvailable ? (
          <ActionForm
            heading="Split"
            hint="The explicit reversal of a mistaken merge: replays the merge's manifest backward (references the world re-aimed since are left alone) and reactivates this record."
            buttonLabel="Split record back out"
            onSubmit={singleRefOp(splitRecord)}
          />
        ) : (
          <p className="notice">
            This record is merged and no reversible manifest exists — it
            cannot be split automatically.
          </p>
        )
      ) : null}
    </main>
  );
}
