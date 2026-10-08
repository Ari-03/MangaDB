// The Description section of the edit and propose forms for a record's one
// editorial text (lib/moderationFields.ts editorialField): the text with a
// live preview of how the page shows it, the source the text is credited
// to (lib/editForm.tsx draftCitation), and the blurbs the sources offer,
// each with "Use this description", which fills the text and its source
// without saving anything.

import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useRef, useState } from "react";

import { api } from "../../convex/_generated/api";
import type { Citation, FieldDescriptor, RecordType } from "../../convex/lib/moderationFields";
import { BlurbSource } from "~/lib/contextEdit";
import { useHashFocus } from "~/lib/coverField";
import { citableUrl, draftCitation, sourceKeys, sourceMode, type FormState } from "~/lib/editForm";

type Blurbs = NonNullable<FunctionReturnType<typeof api.moderation.sourceBlurbs>>;
type Blurb = Blurbs["blurbs"][number];

/** The record types whose sources offer text (convex/moderation.ts sourceBlurbs). */
const BLURB_TYPES = ["release", "series", "volume", "releaseBundle"] as const;
type BlurbType = (typeof BLURB_TYPES)[number];
const takesBlurbs = (type: RecordType): type is BlurbType =>
  (BLURB_TYPES as readonly string[]).includes(type);

/** Where each record type's text shows, said at the top of the section. */
const SHOWN_ON: Partial<Record<RecordType, string>> = {
  release:
    "Shows on the edition page, and on volume pages when this release outranks the edition's other releases: a Human Override first, then the current publisher's, physical, earliest dated, longest.",
  volume:
    "Shows on the volume page, and on a single-volume edition's page when that edition's releases have no description.",
  series:
    "Shows on the series page, and on volume and edition pages that have no text of their own, labelled About the series.",
  releaseBundle: "Shows on the box set page.",
};

/** The host of a source page, for the Keep radio's reminder. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * The Description section. `values` and `dirty` are the form's draft;
 * `setValues` changes several keys at once (Use this description fills the
 * text and its source together). `initialText` is the stored text, so the
 * section knows when the text holds unsaved edits.
 */
export function DescriptionField({
  type,
  recordId,
  field,
  attribution,
  values,
  dirty,
  initialText,
  setValues,
  disabled,
}: {
  type: RecordType;
  recordId: string;
  field: FieldDescriptor;
  attribution: Citation | null;
  values: FormState;
  dirty: ReadonlySet<string>;
  initialText: string;
  setValues: (patch: FormState) => void;
  disabled: boolean;
}) {
  const heading = useHashFocus("description");
  const textarea = useRef<HTMLTextAreaElement>(null);
  const keys = sourceKeys(field.name);
  const text = values[field.name] ?? "";
  const empty = text.trim() === "";
  const mode = sourceMode(values, field.name, attribution);
  const cited = draftCitation(field, values, new Set([...dirty, field.name]), attribution);
  // The credit the page will show once saved, for the preview.
  const preview = cited.ok ? cited.citation : null;
  const choose = (next: string) => setValues({ [keys.mode]: next });

  return (
    <section className="mod-panel description-section" aria-labelledby="description">
      <h2 id="description" ref={heading} tabIndex={-1}>
        {field.label}
      </h2>
      {SHOWN_ON[type] ? <p className="section-hint">{SHOWN_ON[type]}</p> : null}
      <div className="description-editor">
        <label>
          <span className="label-row">
            Text
            <span className="count">{text.trim().length} characters</span>
          </span>
          <textarea
            ref={textarea}
            rows={8}
            value={text}
            disabled={disabled}
            onChange={(event) => setValues({ [field.name]: event.target.value })}
          />
        </label>
        <div className="description-preview">
          <p className="k">Preview</p>
          {empty ? (
            <p className="note">
              No description. The page falls back to the volume or series text.
            </p>
          ) : (
            <div className="detail-blurb">
              <p className="blurb-text">{text.trim()}</p>
              <BlurbSource attribution={preview} />
            </div>
          )}
        </div>
        <fieldset className="source-choice" disabled={disabled || empty}>
          <legend>Source of this text</legend>
          {attribution ? (
            <label>
              <input
                type="radio"
                name={keys.mode}
                checked={mode === "keep"}
                onChange={() => choose("keep")}
              />
              <span>
                Keep: {attribution.sourceName}{" "}
                <span className="sub">({hostOf(attribution.url)})</span>
              </span>
            </label>
          ) : null}
          {mode === "observation" ? (
            <label>
              <input type="radio" name={keys.mode} checked readOnly />
              <span>
                From a source listed below: {values[keys.name]}{" "}
                <span className="sub">({hostOf(values[keys.url] ?? "")})</span>
              </span>
            </label>
          ) : null}
          <label>
            <input
              type="radio"
              name={keys.mode}
              checked={mode === "custom"}
              onChange={() => choose("custom")}
            />
            <span>Another page</span>
          </label>
          {mode === "custom" ? (
            <div className="source-custom">
              <label>
                Source name
                <input
                  value={values[keys.name] ?? ""}
                  placeholder="Kodansha USA, Publisher's back cover…"
                  onChange={(event) => setValues({ [keys.name]: event.target.value })}
                />
              </label>
              <label>
                Source URL
                <input
                  type="url"
                  value={values[keys.url] ?? ""}
                  placeholder="https://…"
                  onChange={(event) => setValues({ [keys.url]: event.target.value })}
                />
              </label>
              {!cited.ok ? (
                <p className="form-error" role="alert">
                  {cited.message}
                </p>
              ) : null}
            </div>
          ) : null}
          <label>
            <input
              type="radio"
              name={keys.mode}
              checked={mode === "none"}
              onChange={() => choose("none")}
            />
            <span>Original prose, no external source</span>
          </label>
        </fieldset>
      </div>
      {takesBlurbs(type) ? (
        <SourceBlurbs
          recordRef={{ type, id: recordId }}
          text={text}
          unsaved={dirty.has(field.name) && text !== initialText && !empty}
          disabled={disabled}
          onUse={(blurb) => {
            const citable = citableUrl(blurb.url);
            setValues({
              [field.name]: blurb.text,
              [keys.mode]: citable ? "observation" : "custom",
              [keys.name]: blurb.sourceName,
              [keys.url]: citable ? (blurb.url ?? "") : "",
              [keys.observation]: citable ? blurb.observationId : "",
            });
            textarea.current?.scrollIntoView({ block: "center" });
            textarea.current?.focus({ preventScroll: true });
          }}
        />
      ) : null}
    </section>
  );
}

/**
 * Every blurb the sources offer for the record, newest sighting as they
 * come, each with "Use this description". When the text holds unsaved
 * edits, the button asks first, inline. The blurb whose text is in the
 * editor shows "In use".
 */
function SourceBlurbs({
  recordRef,
  text,
  unsaved,
  disabled,
  onUse,
}: {
  recordRef: { type: BlurbType; id: string };
  text: string;
  unsaved: boolean;
  disabled: boolean;
  onUse: (blurb: Blurb) => void;
}) {
  const result = useQuery(api.moderation.sourceBlurbs, { ref: recordRef });
  const [confirming, setConfirming] = useState<string | null>(null);
  if (result === undefined) return <p className="mod-empty">Loading source descriptions…</p>;
  if (result === null) return null;
  const { canonical, blurbs } = result;
  const authorship =
    canonical.author === null
      ? "The current text predates revision history."
      : canonical.author.kind === "user"
        ? `The current text was written by ${
            canonical.author.username ? `@${canonical.author.username}` : "a deleted account"
          }.`
        : `The current text was imported from ${canonical.author.sourceKey}.`;

  return (
    <div className="source-blurbs">
      <h3>From the sources</h3>
      <p className="section-hint">
        {canonical.text === null ? "No text yet." : authorship}
        {canonical.overridden ? " It is a Human Override: imports never replace it." : null}
        {result.truncated ? " Showing the first 50 linked source records." : null}
      </p>
      {blurbs.length === 0 ? (
        <p className="mod-empty">No sources offer text for this record.</p>
      ) : (
        <ol className="source-list">
          {blurbs.map((blurb) => {
            const key = `${blurb.observationId}:${blurb.text}`;
            const inUse = blurb.text === text.trim();
            return (
              <li key={key}>
                <div className="source-meta">
                  <span className="who">{blurb.sourceName}</span>
                  {blurb.current ? (
                    <span className="chip mod-chip mod-chip--ok">current</span>
                  ) : null}
                  {blurb.recordedOnly ? (
                    <span className="chip mod-chip mod-chip--mute">
                      recorded only ({blurb.recordedOnly.reason})
                    </span>
                  ) : null}
                  {blurb.withdrawn ? (
                    <span className="chip mod-chip mod-chip--warn">withdrawn at source</span>
                  ) : null}
                  <time dateTime={new Date(blurb.lastSeenAt).toISOString()}>
                    seen{" "}
                    {new Date(blurb.lastSeenAt).toLocaleDateString(undefined, {
                      year: "numeric",
                      month: "short",
                      day: "numeric",
                    })}
                  </time>
                  {inUse ? (
                    <button type="button" className="btn btn-sm" disabled>
                      In use
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={disabled}
                      onClick={() => {
                        if (unsaved) setConfirming(key);
                        else onUse(blurb);
                      }}
                    >
                      Use this description
                    </button>
                  )}
                </div>
                {confirming === key ? (
                  <p className="inline-confirm" role="alert">
                    Replace your unsaved text?{" "}
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => {
                        setConfirming(null);
                        onUse(blurb);
                      }}
                    >
                      Replace
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => setConfirming(null)}
                    >
                      Keep mine
                    </button>
                  </p>
                ) : null}
                <p className="source-text">{blurb.text}</p>
                {blurb.withdrawn ? (
                  <p className="field-help">
                    Withdrawn at the source; cite it only if you have checked it still describes
                    this book.
                  </p>
                ) : null}
                {blurb.url ? (
                  <p className="source-link">
                    <a href={blurb.url} target="_blank" rel="noreferrer">
                      View at {blurb.sourceName}
                    </a>
                    {citableUrl(blurb.url) ? null : " (not an https page: name another to cite it)"}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
