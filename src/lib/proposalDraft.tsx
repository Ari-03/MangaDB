// The Draft Proposal round trip the proposal forms share (/mod/propose,
// /mod/propose-new and the reader's /suggest): save the draft, submit it
// for review, and ask for explicit acknowledgment when convex/proposals.ts
// answers with warnings.

import { useNavigate } from "@tanstack/react-router";
import { useMutation } from "convex/react";
import type { FunctionArgs } from "convex/server";
import { useState } from "react";

import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { PROPOSAL_WARNINGS } from "../../convex/lib/proposalWarnings";
import { mutationErrorMessage } from "~/lib/errors";

/** A draft's content: everything saveDraft takes except the draft it updates. */
export type DraftContent = Omit<FunctionArgs<typeof api.proposals.saveDraft>, "proposalId">;

/** The readable text of a proposal warning code. */
export function warningLabel(warning: string): string {
  return PROPOSAL_WARNINGS[warning as keyof typeof PROPOSAL_WARNINGS] ?? warning;
}

/**
 * The warnings a submitProposal rejection asks to acknowledge
 * (`warningsUnacknowledged`); null for any other failure.
 */
export function unacknowledgedWarnings(err: unknown): string[] | null {
  const data = (err as { data?: unknown })?.data as
    | { code?: string; warnings?: string[] }
    | undefined;
  return data?.code === "warningsUnacknowledged" && data.warnings ? data.warnings : null;
}

/**
 * One proposal form's draft state. `saveDraft` and `submit` take a builder
 * so a field that fails to parse (it throws) reads as the save's error;
 * submitting saves first, then opens the submitted proposal: on /mod, or a
 * reader's Suggestion under /me (`suggest`). Saves go to `resume`, a Draft
 * the author is revising, until the first save names one. A submission
 * with unacknowledged warnings parks them in `pendingWarnings` for
 * <ProposalWarnings>.
 */
export function useProposalDraft({
  resume,
  suggest = false,
}: {
  resume?: Id<"proposals">;
  suggest?: boolean;
} = {}) {
  const navigate = useNavigate();
  const saveDraftMutation = useMutation(api.proposals.saveDraft);
  const submitProposal = useMutation(api.proposals.submitProposal);
  const [draftId, setDraftId] = useState<Id<"proposals"> | null>(resume ?? null);
  const [pendingWarnings, setPendingWarnings] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedDraft, setSavedDraft] = useState(false);

  const save = async (build: () => DraftContent): Promise<Id<"proposals">> => {
    const { proposalId } = await saveDraftMutation({
      proposalId: draftId ?? undefined,
      ...build(),
    });
    setDraftId(proposalId);
    return proposalId;
  };

  const saveDraft = async (build: () => DraftContent) => {
    setBusy(true);
    setError(null);
    try {
      await save(build);
      setSavedDraft(true);
    } catch (err) {
      setError(mutationErrorMessage(err, "Saving the draft failed."));
    } finally {
      setBusy(false);
    }
  };

  const submit = async (build: () => DraftContent, acknowledgeWarnings?: string[]) => {
    setBusy(true);
    setError(null);
    try {
      const proposalId = await save(build);
      await submitProposal({ proposalId, acknowledgeWarnings });
      const params = { id: proposalId as string };
      if (suggest) await navigate({ to: "/me/suggestions/$id", params });
      else await navigate({ to: "/mod/proposal/$id", params });
    } catch (err) {
      const warnings = unacknowledgedWarnings(err);
      if (warnings) {
        setPendingWarnings(warnings);
      } else {
        setError(mutationErrorMessage(err, "Submitting the proposal failed."));
      }
    } finally {
      setBusy(false);
    }
  };

  return {
    draftId,
    pendingWarnings,
    busy,
    error,
    savedDraft,
    /** Drop the "Draft saved" note once the form changes again. */
    clearSaved: () => setSavedDraft(false),
    saveDraft,
    submit,
  };
}

/** The warnings a submission must acknowledge, with the button that does. */
export function ProposalWarnings({
  warnings,
  busy,
  onAcknowledge,
}: {
  warnings: string[];
  busy: boolean;
  onAcknowledge: (warnings: string[]) => void;
}) {
  return (
    <div className="notice">
      <p>This proposal carries warnings:</p>
      <ul>
        {warnings.map((warning) => (
          <li key={warning}>{warningLabel(warning)}</li>
        ))}
      </ul>
      <button
        type="button"
        className="btn btn-sm btn-primary"
        disabled={busy}
        onClick={() => onAcknowledge(warnings)}
      >
        Acknowledge and submit
      </button>
    </div>
  );
}
