import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import { useState } from "react";

import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { PROPOSAL_WARNINGS } from "../../convex/proposals";
import { mutationErrorMessage } from "~/lib/editForm";
import { useIsDataTeam } from "~/lib/moderation";
import { convexClient } from "~/providers";

/**
 * The atomic multi-record proposal (ticket #32, spec §5): one Proposal that
 * creates a new Volume, an Edition covering it, and a Release — wired
 * together with temp-IDs so approval lands all three (plus coverage) in one
 * mutation, or nothing. Data-Team-only; never indexed.
 */
export const Route = createFileRoute("/mod/propose-new/$seriesPublicId")({
  head: () => ({
    meta: [
      { title: "Propose new records — MangaDB" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: ProposeNewPage,
});

function ProposeNewPage() {
  const { seriesPublicId } = Route.useParams();
  if (!convexClient) {
    return (
      <main>
        <p className="notice">
          Proposals need a configured Convex deployment (see the README).
        </p>
      </main>
    );
  }
  const publicId = Number(seriesPublicId);
  if (!Number.isInteger(publicId)) {
    return (
      <main>
        <h1>Unknown series</h1>
        <p className="notice">
          Nothing lives at this address. <Link to="/">Go home</Link>.
        </p>
      </main>
    );
  }
  return <Gate publicId={publicId} />;
}

function Gate({ publicId }: { publicId: number }) {
  const isDataTeam = useIsDataTeam();
  const viewer = useQuery(api.users.viewer, {});
  if (viewer === undefined) {
    return (
      <main>
        <p className="notice">Checking your access…</p>
      </main>
    );
  }
  if (!isDataTeam) {
    return (
      <main>
        <h1>Data team only</h1>
        <p className="notice">
          Proposing new records needs an Editor (or stronger) role.{" "}
          {viewer === null ? <a href="/sign-in">Sign in</a> : null}
        </p>
      </main>
    );
  }
  return <ProposeNewForm publicId={publicId} />;
}

function ProposeNewForm({ publicId }: { publicId: number }) {
  const navigate = useNavigate();
  const form = useQuery(api.proposals.newRecordsForm, {
    seriesPublicId: publicId,
  });
  const saveDraft = useMutation(api.proposals.saveDraft);
  const submitProposal = useMutation(api.proposals.submitProposal);

  const [volumeLabel, setVolumeLabel] = useState("");
  const [publisherId, setPublisherId] = useState("");
  const [linePosition, setLinePosition] = useState("");
  const [format, setFormat] = useState<"physical" | "digital">("physical");
  const [binding, setBinding] = useState("");
  const [language, setLanguage] = useState("en");
  const [isbn13, setIsbn13] = useState("");
  const [year, setYear] = useState("");
  const [month, setMonth] = useState("");
  const [day, setDay] = useState("");
  const [comment, setComment] = useState("");
  const [evidenceUrl, setEvidenceUrl] = useState("");
  const [draftId, setDraftId] = useState<Id<"proposals"> | null>(null);
  const [pendingWarnings, setPendingWarnings] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedDraft, setSavedDraft] = useState(false);

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
        <h1>Series not found</h1>
        <p className="notice">
          No active series matches this address. <Link to="/">Go home</Link>.
        </p>
      </main>
    );
  }

  const buildArgs = () => {
    const pubDate =
      year.trim() !== ""
        ? {
            year: Number(year),
            ...(month.trim() !== "" ? { month: Number(month) } : {}),
            ...(day.trim() !== "" ? { day: Number(day) } : {}),
          }
        : undefined;
    return {
      proposalId: draftId ?? undefined,
      ops: [
        {
          kind: "create" as const,
          table: "volumes",
          tempId: "volume-1",
          fields: {
            seriesId: form.seriesId,
            label: volumeLabel.trim() || undefined,
          },
        },
        {
          kind: "create" as const,
          table: "editions",
          tempId: "edition",
          fields: {
            publisherId,
            linePosition: linePosition.trim() || undefined,
            volumeCoverage: [
              { volume: "volume-1", order: 1, extent: "complete" as const },
            ],
          },
        },
        {
          kind: "create" as const,
          table: "releases",
          tempId: "release",
          fields: {
            editionId: "edition",
            format,
            binding:
              format === "physical" && binding.trim() !== ""
                ? binding.trim()
                : undefined,
            language: language.trim(),
            isbn13: isbn13.trim() || undefined,
            pubDate,
          },
        },
      ],
      evidence:
        evidenceUrl.trim() !== ""
          ? [{ kind: "url" as const, url: evidenceUrl.trim() }]
          : [],
      comment,
    };
  };

  const save = async (): Promise<Id<"proposals">> => {
    const { proposalId } = await saveDraft(buildArgs());
    setDraftId(proposalId);
    return proposalId;
  };

  const onSaveDraft = async () => {
    setBusy(true);
    setError(null);
    try {
      await save();
      setSavedDraft(true);
    } catch (err) {
      setError(mutationErrorMessage(err, "Saving the draft failed."));
    } finally {
      setBusy(false);
    }
  };

  const onSubmit = async (acknowledgeWarnings?: string[]) => {
    setBusy(true);
    setError(null);
    try {
      const proposalId = await save();
      await submitProposal({ proposalId, acknowledgeWarnings });
      await navigate({
        to: "/mod/proposal/$id",
        params: { id: proposalId as string },
      });
    } catch (err) {
      const data = (err as { data?: unknown })?.data as
        | { code?: string; warnings?: string[] }
        | undefined;
      if (data?.code === "warningsUnacknowledged" && data.warnings) {
        setPendingWarnings(data.warnings);
      } else {
        setError(mutationErrorMessage(err, "Submitting the proposal failed."));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mod-edit-page">
      <nav className="breadcrumbs" aria-label="Breadcrumb">
        <Link to="/">MangaDB</Link> <span aria-hidden="true">/</span>{" "}
        <span>Propose new records</span>
      </nav>
      <h1>New volume + edition + release: {form.title}</h1>
      <p className="section-hint">
        One atomic proposal creates all three records together (temp-IDs wire
        the references). The volume lands after the series' current{" "}
        {form.volumeCount} volume{form.volumeCount === 1 ? "" : "s"}.
      </p>
      <form
        className="mod-edit-form"
        onSubmit={(event) => {
          event.preventDefault();
          void onSubmit();
        }}
      >
        <label>
          Volume label
          <input
            value={volumeLabel}
            onChange={(event) => setVolumeLabel(event.target.value)}
            placeholder={`e.g. ${form.volumeCount + 1}`}
          />
          <span className="field-help">
            Publisher-facing designation; leave empty for an unnumbered volume.
          </span>
        </label>
        <label>
          Publisher (required)
          <select
            value={publisherId}
            onChange={(event) => setPublisherId(event.target.value)}
            required
          >
            <option value="">Choose a publisher…</option>
            {form.publishers.map((publisher) => (
              <option key={publisher.id} value={publisher.id}>
                {publisher.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Edition line position
          <input
            value={linePosition}
            onChange={(event) => setLinePosition(event.target.value)}
            placeholder='e.g. "Omnibus 1" (usually empty)'
          />
        </label>
        <label>
          Format
          <select
            value={format}
            onChange={(event) =>
              setFormat(event.target.value === "digital" ? "digital" : "physical")
            }
          >
            <option value="physical">physical</option>
            <option value="digital">digital</option>
          </select>
        </label>
        {format === "physical" ? (
          <label>
            Binding
            <input
              value={binding}
              onChange={(event) => setBinding(event.target.value)}
              placeholder="paperback, hardcover…"
            />
          </label>
        ) : null}
        <label>
          Language (required)
          <input
            value={language}
            onChange={(event) => setLanguage(event.target.value)}
            required
          />
        </label>
        <label>
          ISBN-13
          <input value={isbn13} onChange={(event) => setIsbn13(event.target.value)} />
        </label>
        <fieldset className="date-fieldset">
          <legend>Publication date</legend>
          <label>
            Year
            <input
              inputMode="numeric"
              value={year}
              onChange={(event) => setYear(event.target.value)}
            />
          </label>
          <label>
            Month
            <input
              inputMode="numeric"
              value={month}
              onChange={(event) => setMonth(event.target.value)}
            />
          </label>
          <label>
            Day
            <input
              inputMode="numeric"
              value={day}
              onChange={(event) => setDay(event.target.value)}
            />
          </label>
        </fieldset>
        <label>
          Change comment (required)
          <textarea
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            rows={2}
            required
          />
        </label>
        <label>
          Source evidence URL (required — creations assert facts)
          <input
            type="url"
            value={evidenceUrl}
            onChange={(event) => setEvidenceUrl(event.target.value)}
            placeholder="https://publisher.example/the-announcement"
          />
        </label>
        <div>
          <button
            type="button"
            disabled={busy || publisherId === ""}
            onClick={() => void onSaveDraft()}
          >
            Save draft
          </button>{" "}
          <button
            type="submit"
            disabled={busy || publisherId === "" || comment.trim() === ""}
          >
            {busy ? "Working…" : "Submit for review"}
          </button>
        </div>
        {pendingWarnings ? (
          <div className="notice">
            <p>This proposal carries warnings:</p>
            <ul>
              {pendingWarnings.map((warning) => (
                <li key={warning}>
                  {PROPOSAL_WARNINGS[warning as keyof typeof PROPOSAL_WARNINGS] ??
                    warning}
                </li>
              ))}
            </ul>
            <button
              type="button"
              disabled={busy}
              onClick={() => void onSubmit(pendingWarnings)}
            >
              Acknowledge and submit
            </button>
          </div>
        ) : null}
        {error ? <p className="form-error">{error}</p> : null}
        {savedDraft && draftId ? (
          <p className="notice">
            Draft saved.{" "}
            <Link to="/mod/proposal/$id" params={{ id: draftId as string }}>
              View it
            </Link>
            .
          </p>
        ) : null}
      </form>
    </main>
  );
}
