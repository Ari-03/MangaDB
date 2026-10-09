// A Proposal's content as its pages show it: each op with before and
// after per record (convex/proposals.ts renderOps) and the evidence beside
// it (renderEvidence). The Data Team's proposal page (/mod/proposal) and a
// reader's own Suggestion (/me/suggestions) both draw them.

import type { renderEvidence, renderOps } from "../../convex/proposals";
import type { readerOps } from "../../convex/suggestions";
import { editorialField } from "../../convex/lib/moderationFields";
import {
  CLEAR_OVERRIDE_HINT,
  FieldChangeItem,
  renderFieldValue,
  StatedSource,
  writtenByLabel,
  type CoverArt,
} from "~/lib/moderation";

type RenderedOps = Awaited<ReturnType<typeof renderOps | typeof readerOps>>;
type RenderedEvidence = Awaited<ReturnType<typeof renderEvidence>>;

/** A version's or a Draft's ops, in order, with cover art for cover changes. */
export function OpsList({ ops, art }: { ops: RenderedOps; art: CoverArt }) {
  return (
    <ol className="proposal-ops">
      {ops.map((op, i) => (
        <li
          // biome-ignore lint/suspicious/noArrayIndexKey: each op renders text with no state, so a key by position only re-renders in place
          key={i}
          className="proposal-op"
        >
          {op.kind === "create" ? (
            <>
              <p>
                <strong>{op.summary}</strong> <code className="temp-id">temp:{op.tempId}</code>
              </p>
              <ul className="revision-changes">
                {Object.entries(op.fields ?? {}).map(([field, value]) =>
                  value === undefined ? null : (
                    <li key={field}>
                      <code>{field}</code>: <ins>{renderFieldValue(value)}</ins>
                    </li>
                  ),
                )}
              </ul>
            </>
          ) : op.kind === "update" ? (
            <>
              <p>
                <strong>
                  Update {op.recordType}: {op.recordTitle}
                </strong>{" "}
                <span className="proposal-base">
                  (base: revision #{op.base.seq}
                  {op.base.comment ? ` — ${op.base.comment}` : ""})
                </span>{" "}
                {op.stale ? <span className="chip mod-chip mod-chip--bad">stale</span> : null}
              </p>
              <ul className="revision-changes">
                {op.changes.map((change) => (
                  <FieldChangeItem
                    key={change.field}
                    change={change}
                    art={art}
                    afterOnly={op.withheld}
                  />
                ))}
              </ul>
              {op.citation !== undefined ? (
                <StatedSource
                  field={editorialField(op.recordType)?.name ?? "text"}
                  citation={op.citation}
                />
              ) : null}
            </>
          ) : op.kind === "clearOverride" ? (
            <>
              <p>
                <strong>
                  Clear the Human Override on {op.fieldLabel} of {op.recordType}: {op.recordTitle}
                </strong>{" "}
                <span className="proposal-base">
                  (base: revision #{op.base.seq}
                  {op.base.comment ? ` — ${op.base.comment}` : ""})
                </span>{" "}
                {op.stale ? <span className="chip mod-chip mod-chip--bad">stale</span> : null}
              </p>
              <ul className="revision-changes">
                {op.kept ? (
                  <li>
                    <code>{op.field}</code> keeps its value: {renderFieldValue(op.kept.value)} (
                    {writtenByLabel(op.kept.writtenBy)})
                  </li>
                ) : null}
                <li>{CLEAR_OVERRIDE_HINT}</li>
              </ul>
            </>
          ) : (
            <p>
              {/* Sensitive catalog operations render as a
                  one-line summary; their full impact preview lives on the
                  record's manage panel. A reader's page names any op but
                  an update the same way, without its records. */}
              <strong>{op.summary}</strong>
            </p>
          )}
        </li>
      ))}
    </ol>
  );
}

/**
 * The evidence rows beside a version's ops: links, source records and
 * notes. With `onRemove`, each row has a Remove button that passes its
 * index (the suggest form's evidence kept from a Draft).
 */
export function EvidenceList({
  evidence,
  onRemove,
}: {
  evidence: RenderedEvidence;
  onRemove?: (index: number) => void;
}) {
  if (evidence.length === 0) {
    return <p className="section-hint">No evidence attached.</p>;
  }
  return (
    <ul className="proposal-evidence">
      {evidence.map((row, i) => (
        <li
          // biome-ignore lint/suspicious/noArrayIndexKey: known defect, left for its own fix: a row removed above a focused link moves that focus to the next row's link (docs/known-issues.md, Interface)
          key={i}
        >
          {row.kind === "url" ? (
            <>
              <a href={row.url} rel="nofollow noreferrer">
                {row.url}
              </a>
              {row.note ? ` — ${row.note}` : null}
            </>
          ) : row.kind === "observation" ? (
            <>
              Source observation: {row.sourceKey}
              {row.url ? (
                <>
                  {" "}
                  (
                  <a href={row.url} rel="nofollow noreferrer">
                    record page
                  </a>
                  )
                </>
              ) : null}
            </>
          ) : (
            <>Note: {row.text}</>
          )}
          {onRemove ? (
            <>
              {" "}
              <button type="button" className="btn btn-sm" onClick={() => onRemove(i)}>
                Remove
              </button>
            </>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
