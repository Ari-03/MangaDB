import { createFileRoute, Link } from "@tanstack/react-router";
import { ConvexError } from "convex/values";
import { useAction, useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useState } from "react";

import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { useIsModerator } from "~/lib/moderation";
import { convexClient } from "~/providers";
import { slugParams } from "~/lib/slug";

/**
 * The launch dashboard (ticket #40, spec §7): seed-stage progress and
 * controls, the quality-gate samples and duplicate sweep, Bootstrap Mode,
 * the correction-loop attestation, and the computed launch-ready checklist.
 * Data-Team-visible; the actions are Moderator/Administrator-gated
 * server-side. Never indexed.
 */
export const Route = createFileRoute("/mod/launch")({
  head: () => ({
    meta: [
      { title: "Launch — MangaDB" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: LaunchPage,
});

function errorMessage(err: unknown): string {
  if (err instanceof ConvexError && typeof err.data === "object" && err.data !== null) {
    const message = (err.data as { message?: string }).message;
    if (message) return message;
  }
  return "That didn't go through. Try again.";
}

function LaunchPage() {
  if (!convexClient) {
    return (
      <main>
        <p className="notice">
          The launch dashboard needs a configured Convex deployment (see the
          README).
        </p>
      </main>
    );
  }
  return <LaunchGate />;
}

function LaunchGate() {
  const viewer = useQuery(api.users.viewer, {});
  const isModerator = useIsModerator();
  if (viewer === undefined) {
    return (
      <main>
        <p className="notice">Checking your access…</p>
      </main>
    );
  }
  const isDataTeam = Boolean(
    viewer && !viewer.needsUsername && viewer.role !== null,
  );
  if (!isDataTeam) {
    return (
      <main>
        <h1>Data team only</h1>
        <p className="notice">
          The launch dashboard is visible to Editors, Moderators, and
          Administrators.{" "}
          {viewer === null ? <a href="/sign-in">Sign in</a> : null}
        </p>
      </main>
    );
  }
  return <Launch canAct={isModerator} />;
}

const timestamp = (ms: number) =>
  new Date(ms).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

function Launch({ canAct }: { canAct: boolean }) {
  return (
    <main className="launch-page">
      <nav className="breadcrumbs" aria-label="Breadcrumb">
        <Link to="/">MangaDB</Link> <span aria-hidden="true">/</span>{" "}
        <span>Launch</span>
      </nav>
      <h1>Seeding, quality gates &amp; launch</h1>
      <p className="section-hint">
        Spec §7: run the four seed stages in order under Bootstrap Mode, pass
        the quality gates, switch Bootstrap Mode off permanently, and verify
        the checklist before opening mangadb.org.{" "}
        <Link to="/mod/imports">Imports</Link> ·{" "}
        <Link to="/mod/queue">Review queue</Link>
      </p>

      <Checklist />
      <SeedStages canAct={canAct} />
      <QaSamples canAct={canAct} />
      <DuplicateSweep canAct={canAct} />
      <CorrectionLoop canAct={canAct} />
    </main>
  );
}

// ---------- the launch-ready checklist ----------

const GATE_LABELS: Array<[string, string]> = [
  ["seedStagesComplete", "All four seed stages have completed a full run, in order"],
  ["qualityGatesPass", "Quality gates pass (both samples verified, duplicate sweep resolved)"],
  ["bootstrapOff", "Bootstrap Mode is off"],
  ["calendarPopulated", "The upcoming-release calendar is populated"],
  ["sourcesHealthy", "All five sources are enabled, healthy, and have succeeded"],
  ["correctionLoopExercised", "The correction loop was exercised end-to-end for real"],
  ["aboutDataPage", 'The "about the data" page exists'],
];

function Checklist() {
  const checklist = useQuery(api.launch.launchChecklist, {});
  if (checklist === undefined) return <p className="notice">Loading…</p>;
  return (
    <section>
      <h2>Launch-ready checklist</h2>
      <ul className="launch-gates">
        {GATE_LABELS.map(([key, label]) => {
          const ok = checklist.gates[key as keyof typeof checklist.gates];
          return (
            <li key={key} className={ok ? "gate-pass" : "gate-open"}>
              <span aria-hidden="true">{ok ? "✓" : "✗"}</span> {label}
            </li>
          );
        })}
      </ul>
      <p className={checklist.ready ? "notice launch-ready" : "notice"}>
        {checklist.ready
          ? "Every gate passes — launch-ready."
          : "Not launch-ready yet. Non-gates (spec §7): digital parity, an empty bootstrap-unreviewed backlog, and any minimum series count never hold the launch."}
      </p>
    </section>
  );
}

// ---------- seed stages ----------

function SeedStages({ canAct }: { canAct: boolean }) {
  const status = useQuery(api.launch.seedStatus, {});
  const start = useMutation(api.launch.startSeedStage);
  const setBootstrap = useMutation(api.importSources.setBootstrapMode);
  const [error, setError] = useState<string | null>(null);

  if (status === undefined) return <p className="notice">Loading…</p>;
  return (
    <section>
      <h2>Seed stages</h2>
      <p className="section-hint">
        Bootstrap Mode is{" "}
        <strong>{status.bootstrapMode ? "ON" : "OFF"}</strong>
        {canAct ? (
          <>
            {" "}
            <button
              type="button"
              onClick={() => {
                setError(null);
                setBootstrap({ on: !status.bootstrapMode }).catch(
                  (err: unknown) => setError(errorMessage(err)),
                );
              }}
            >
              Turn {status.bootstrapMode ? "off (permanent before launch)" : "on"}
            </button>
          </>
        ) : null}
        {status.orderedOk ? null : (
          <strong className="import-flag"> — stages ran out of order</strong>
        )}
      </p>
      <ol className="seed-stages">
        {status.stages.map((stage) => (
          <li key={stage.stage}>
            <strong>{stage.name}</strong>{" "}
            {stage.complete ? (
              <span className="gate-pass">
                complete {stage.completedAt ? timestamp(stage.completedAt) : ""}
              </span>
            ) : (
              <span className="gate-open">not complete</span>
            )}
            <ul>
              {stage.sources.map((source) => (
                <li key={source.key}>
                  {source.key}:{" "}
                  {source.running
                    ? "running…"
                    : source.firstSucceededAt
                      ? `first success ${timestamp(source.firstSucceededAt)}`
                      : "no successful run yet"}
                </li>
              ))}
            </ul>
            {canAct && !stage.complete ? (
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  start({ stage: stage.stage }).catch((err: unknown) =>
                    setError(errorMessage(err)),
                  );
                }}
              >
                Start stage {stage.stage}
              </button>
            ) : null}
          </li>
        ))}
      </ol>
      {error ? <p className="form-error">{error}</p> : null}
    </section>
  );
}

// ---------- QA samples ----------

function QaSamples({ canAct }: { canAct: boolean }) {
  const qa = useQuery(api.launch.qaStatus, {});
  if (qa === undefined) return <p className="notice">Loading…</p>;
  return (
    <section>
      <h2>Quality gates — hand-verification samples</h2>
      <SampleTable
        kind="random"
        title="Random sample (~50 Series across all sources)"
        sample={qa.random}
        canAct={canAct}
      />
      <SampleTable
        kind="prominent"
        title="Most prominent (~50 Series with the most releases)"
        sample={qa.prominent}
        canAct={canAct}
      />
    </section>
  );
}

type Sample = FunctionReturnType<typeof api.launch.qaStatus>["random"];

function SampleTable({
  kind,
  title,
  sample,
  canAct,
}: {
  kind: "random" | "prominent";
  title: string;
  sample: Sample;
  canAct: boolean;
}) {
  const draw = useAction(api.launch.drawQaSample);
  const record = useMutation(api.launch.recordQaCheck);
  const [drawing, setDrawing] = useState(false);
  const [failing, setFailing] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="qa-sample">
      <h3>{title}</h3>
      <p className="section-hint">
        {sample.round === 0
          ? "Not drawn yet."
          : `Round ${sample.round}: ${sample.verified} verified · ${sample.failed} failed · ${sample.pending} pending — ${sample.pass ? "PASS" : "not passing"}`}
        {canAct ? (
          <>
            {" "}
            <button
              type="button"
              disabled={drawing}
              onClick={() => {
                setError(null);
                setDrawing(true);
                draw({ kind })
                  .catch((err: unknown) => setError(errorMessage(err)))
                  .finally(() => setDrawing(false));
              }}
            >
              {drawing
                ? "Drawing…"
                : sample.round === 0
                  ? "Draw sample"
                  : "Redraw (after a pipeline-wide fix)"}
            </button>
          </>
        ) : null}
      </p>
      {sample.rows.length > 0 ? (
        <ul className="qa-rows">
          {sample.rows.map((row) => (
            <li key={row._id}>
              <Link
                to="/series/$publicId/$slug"
                params={slugParams(row.publicId, row.title)}
              >
                {row.title}
              </Link>{" "}
              — {row.status}
              {row.note ? <em> ({row.note})</em> : null}
              {canAct && row.status === "pending" ? (
                failing === row._id ? (
                  <span className="qa-fail-form">
                    <input
                      value={note}
                      onChange={(event) => setNote(event.target.value)}
                      placeholder="What's wrong? (names the error class)"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        setError(null);
                        record({
                          checkId: row._id as Id<"qaChecks">,
                          status: "failed",
                          note,
                        })
                          .then(() => {
                            setFailing(null);
                            setNote("");
                          })
                          .catch((err: unknown) => setError(errorMessage(err)));
                      }}
                    >
                      Record failure
                    </button>
                    <button type="button" onClick={() => setFailing(null)}>
                      Cancel
                    </button>
                  </span>
                ) : (
                  <span className="qa-actions">
                    <button
                      type="button"
                      onClick={() => {
                        setError(null);
                        record({
                          checkId: row._id as Id<"qaChecks">,
                          status: "verified",
                        }).catch((err: unknown) => setError(errorMessage(err)));
                      }}
                    >
                      Verified
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setFailing(row._id);
                        setNote("");
                      }}
                    >
                      Fail…
                    </button>
                  </span>
                )
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {error ? <p className="form-error">{error}</p> : null}
    </div>
  );
}

// ---------- duplicate sweep ----------

function DuplicateSweep({ canAct }: { canAct: boolean }) {
  const qa = useQuery(api.launch.qaStatus, {});
  const queue = useQuery(api.launch.duplicateQueue, {});
  const run = useAction(api.launch.runDuplicateSweep);
  const resolve = useMutation(api.launch.resolveDuplicate);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (qa === undefined || queue === undefined) {
    return <p className="notice">Loading…</p>;
  }
  const sweep = qa.duplicates.lastSweep;
  return (
    <section>
      <h2>Quality gates — duplicate sweep</h2>
      <p className="section-hint">
        {sweep
          ? `Last sweep ${timestamp(sweep.ranAt)}: ${sweep.seriesScanned} series scanned, ${sweep.pairsFlagged} pairs flagged. ${qa.duplicates.openCount}${qa.duplicates.hasMore ? "+" : ""} open.`
          : "Never run."}
        {canAct ? (
          <>
            {" "}
            <button
              type="button"
              disabled={running}
              onClick={() => {
                setError(null);
                setRunning(true);
                run({})
                  .catch((err: unknown) => setError(errorMessage(err)))
                  .finally(() => setRunning(false));
              }}
            >
              {running ? "Sweeping…" : "Run title-similarity sweep"}
            </button>
          </>
        ) : null}
      </p>
      {queue.rows.length > 0 ? (
        <ul className="duplicate-queue">
          {queue.rows.map((row) => (
            <li key={row.candidateId}>
              <PairLink publicId={row.a.publicId} title={row.a.title} /> vs{" "}
              <PairLink publicId={row.b.publicId} title={row.b.title} />{" "}
              <em>({row.reason})</em>
              {canAct ? (
                <span className="qa-actions">
                  <button
                    type="button"
                    onClick={() => {
                      setError(null);
                      resolve({
                        candidateId: row.candidateId,
                        resolution: "distinct",
                      }).catch((err: unknown) => setError(errorMessage(err)));
                    }}
                  >
                    Distinct
                  </button>
                  {row.a.publicId !== null ? (
                    <Link
                      to="/mod/manage/$type/$key"
                      params={{ type: "series", key: String(row.a.publicId) }}
                    >
                      Merge…
                    </Link>
                  ) : null}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="notice">No open duplicate candidates.</p>
      )}
      {queue.hasMore ? <p className="section-hint">More pairs follow — resolve these first.</p> : null}
      {error ? <p className="form-error">{error}</p> : null}
    </section>
  );
}

function PairLink({ publicId, title }: { publicId: number | null; title: string }) {
  if (publicId === null) return <span>{title}</span>;
  return (
    <Link to="/series/$publicId/$slug" params={slugParams(publicId, title)}>
      {title}
    </Link>
  );
}

// ---------- correction loop attestation ----------

function CorrectionLoop({ canAct }: { canAct: boolean }) {
  const checklist = useQuery(api.launch.launchChecklist, {});
  const attest = useMutation(api.launch.attestCorrectionLoop);
  const [proposalId, setProposalId] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (checklist === undefined) return null;
  const loop = checklist.detail.correctionLoop;
  return (
    <section>
      <h2>Correction loop</h2>
      <p className="section-hint">
        Launch gate ④: a real report → proposal → approval → public revision
        must have happened. Attest with the approved proposal that fixed a
        reported error (Administrator).
      </p>
      {loop ? (
        <p className="notice gate-pass">
          Attested {timestamp(loop.attestedAt)} on proposal{" "}
          <Link to="/mod/proposal/$id" params={{ id: loop.proposalId }}>
            {loop.proposalId}
          </Link>
          .
        </p>
      ) : canAct ? (
        <form
          className="attest-form"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            attest({ proposalId: proposalId.trim() as Id<"proposals"> }).catch(
              (err: unknown) => setError(errorMessage(err)),
            );
          }}
        >
          <input
            value={proposalId}
            onChange={(event) => setProposalId(event.target.value)}
            placeholder="Approved proposal ID"
            required
          />
          <button type="submit">Attest</button>
          {error ? <p className="form-error">{error}</p> : null}
        </form>
      ) : (
        <p className="notice">Not attested yet.</p>
      )}
    </section>
  );
}
