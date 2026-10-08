// The Cover section of the edit and propose forms (/mod/edit, /mod/propose)
// for a Release or a Bundle: the stored art beside its replacement, which a
// person drops, chooses, pastes, or reuses from a related record, or
// removes. The new cover is one more field of the form's draft (the JSON
// of a CoverDraft under `coverImage`, lib/editForm.tsx), saved with the
// form's one Save and change comment through the usual write path.
//
// A chosen file uploads at once (convex/coverUploads.ts) while the person
// writes the comment; the form holds Save until it lands. Only the newest
// choice ever reaches the draft: a slower earlier upload finishing late is
// ignored. The upload survives Reload latest, which resets field values
// only, so it can be put back with one click.

import { Link } from "@tanstack/react-router";
import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { type CSSProperties, useEffect, useRef, useState } from "react";

import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import {
  COVER_TYPES,
  MAX_COVER_UPLOAD_BYTES,
  MIN_COVER_WIDTH,
} from "../../convex/lib/moderationFields";
import { clothColor } from "~/lib/cover";
import { decodeCover, encodeCover } from "~/lib/editForm";
import { mutationErrorMessage } from "~/lib/errors";

type EditForm = NonNullable<FunctionReturnType<typeof api.moderation.editForm>>;
export type CoverContext = NonNullable<EditForm["cover"]>;

/** Smallest file the server keeps as art (convex/lib/covers.ts MIN_COVER_BYTES). */
const MIN_BYTES = 2048;
const UPLOAD_FAILED = "Upload failed. Nothing was changed. Try again.";

/** What the form says about a chosen file before and after it uploads. */
export type CoverFacts = { width: number; height: number; size: number; type: string };

/**
 * Why a chosen file cannot be a cover, by the upload rules the server also
 * applies (convex/lib/coverRefs.ts checkCoverBlob), or null when it can.
 * `width` is checked only here: the browser has decoded the file.
 */
export function coverFileProblem(file: { type: string; size: number }, width?: number) {
  if (!(COVER_TYPES as readonly string[]).includes(file.type)) {
    return "Only JPEG, PNG or WebP. GIF and SVG are not shelved.";
  }
  if (file.size > MAX_COVER_UPLOAD_BYTES) return "Over 10 MB. Export a smaller JPEG.";
  if (file.size < MIN_BYTES) return "That file is a placeholder, not cover art.";
  if (width !== undefined && width < MIN_COVER_WIDTH) {
    return `Too small to shelve (needs ${MIN_COVER_WIDTH} px wide).`;
  }
  return null;
}

/** "1400 × 2100 px · 612 KB · JPEG", and whether the shelf's 2:3 crop cuts it (off by over 5%). */
export function coverFactsLine(facts: CoverFacts): { line: string; cropped: boolean } {
  const kind = facts.type.replace("image/", "").toUpperCase();
  const size =
    facts.size >= 1024 * 1024
      ? `${(facts.size / (1024 * 1024)).toFixed(1)} MB`
      : `${Math.round(facts.size / 1024)} KB`;
  const ratio = facts.width / facts.height;
  return {
    line: `${facts.width} × ${facts.height} px · ${size} · ${kind}`,
    cropped: Math.abs(ratio - 2 / 3) / (2 / 3) > 0.05,
  };
}

/** A file's pixel size, decoded by the browser; rejects what it cannot read. */
async function measure(file: File): Promise<{ width: number; height: number }> {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(file);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  }
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return { width: image.naturalWidth, height: image.naturalHeight };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Focus a section heading when the page was opened at its anchor (`#cover`, `#description`). */
export function useHashFocus(id: string) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (window.location.hash !== `#${id}`) return;
    ref.current?.scrollIntoView({ block: "start" });
    ref.current?.focus({ preventScroll: true });
  }, [id]);
  return ref;
}

type Upload = {
  token: number;
  preview: string;
  facts: CoverFacts;
  file: File;
} & (
  | { status: "uploading" }
  | { status: "failed"; message: string }
  | { status: "done"; storageId: string }
);

/** Art in the shelf's 2:3 frame, or the cloth placeholder with a line of words. */
function ArtFrame({ url, alt, empty }: { url: string | null; alt: string; empty: string }) {
  return (
    <span className="cover">
      {url ? (
        <img src={url} alt={alt} width={400} height={600} />
      ) : (
        <span
          className="cover-ph"
          style={{ "--cloth": clothColor(alt) } as CSSProperties}
          role="img"
          aria-label={empty}
        >
          <span className="cover-ph-title">{empty}</span>
        </span>
      )}
    </span>
  );
}

/**
 * The Cover section. `value` and `initial` are the form-state strings of
 * the cover (lib/editForm.tsx encodeCover); `setValue` changes it, and
 * `revert` puts back the stored cover untouched. `onUploading` tells the
 * form to hold Save. `proposing` sends the mature-art link to the Series'
 * propose form instead of its edit form.
 */
export function CoverField({
  cover,
  boxSet,
  title,
  value,
  initial,
  setValue,
  revert,
  onUploading,
  overridden,
  disabled,
  proposing,
}: {
  cover: CoverContext;
  boxSet: boolean;
  title: string;
  value: string;
  initial: string;
  setValue: (value: string) => void;
  revert: () => void;
  onUploading: (uploading: boolean) => void;
  overridden: boolean;
  disabled: boolean;
  proposing: boolean;
}) {
  const startUpload = useMutation(api.coverUploads.uploadUrl);
  const finishUpload = useMutation(api.coverUploads.uploaded);
  const heading = useHashFocus("cover");
  const replaceInput = useRef<HTMLInputElement>(null);
  const [upload, setUpload] = useState<Upload | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [focused, setFocused] = useState(false);
  // The newest choice: anything an older one finishes is ignored.
  const token = useRef(0);
  // What the async upload reads when it lands, not what it closed over.
  const latest = useRef({ value, setValue, onUploading });
  latest.current = { value, setValue, onUploading };

  const chosen = decodeCover(value);
  const stored = decodeCover(initial);
  const removed = value === "" && (initial !== "" || cover.current.url !== null);
  const changed = value !== initial;
  const replacement =
    changed && chosen && chosen.storageId !== stored?.storageId ? chosen.storageId : null;

  // The preview URL lives as long as its upload is the one shown.
  const preview = upload?.preview;
  useEffect(() => () => (preview ? URL.revokeObjectURL(preview) : undefined), [preview]);

  const send = async (current: number, file: File) => {
    try {
      const { uploadId, url } = await startUpload({});
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!res.ok) throw new Error(`upload answered ${res.status}`);
      const { storageId } = (await res.json()) as { storageId: Id<"_storage"> };
      const done = await finishUpload({ uploadId, storageId });
      if (current !== token.current) return;
      if (!done.ok) {
        setUpload(null);
        setProblem(done.message);
        return;
      }
      setUpload((prev) =>
        prev?.token === current ? { ...prev, status: "done", storageId } : prev,
      );
      const attribution = decodeCover(latest.current.value)?.attribution ?? "";
      latest.current.setValue(encodeCover({ storageId, attribution }));
    } catch (err) {
      if (current !== token.current) return;
      const message = mutationErrorMessage(err, UPLOAD_FAILED);
      setUpload((prev) =>
        prev?.token === current ? { ...prev, status: "failed", message } : prev,
      );
    } finally {
      if (current === token.current) latest.current.onUploading(false);
    }
  };

  // A new choice abandons any upload still in flight, even when the new
  // file turns out not to be a cover, so Save never waits on a dropped one.
  const choose = async (file: File) => {
    if (disabled) return;
    abandon();
    const current = token.current;
    const early = coverFileProblem(file);
    if (early) {
      setProblem(early);
      return;
    }
    let size: { width: number; height: number };
    try {
      size = await measure(file);
    } catch {
      if (current === token.current) setProblem("That file is not an image the browser can read.");
      return;
    }
    if (current !== token.current) return;
    const late = coverFileProblem(file, size.width);
    if (late) {
      setProblem(late);
      return;
    }
    setProblem(null);
    setUpload({
      token: current,
      preview: URL.createObjectURL(file),
      facts: { ...size, size: file.size, type: file.type },
      file,
      status: "uploading",
    });
    onUploading(true);
    await send(current, file);
  };

  const retry = () => {
    if (!upload || upload.status !== "failed") return;
    const current = ++token.current;
    setUpload({ ...upload, token: current, status: "uploading" });
    onUploading(true);
    void send(current, upload.file);
  };

  // Abandon an upload in flight: its result must not land in the draft.
  const abandon = () => {
    token.current++;
    if (upload?.status === "uploading") {
      setUpload(null);
      onUploading(false);
    }
  };

  // Paste works while focus is inside the section, never page-wide.
  useEffect(() => {
    if (!focused) return;
    const onPaste = (event: ClipboardEvent) => {
      const file = [...(event.clipboardData?.files ?? [])].find((f) => f.type.startsWith("image/"));
      if (!file) return;
      event.preventDefault();
      void choose(file);
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  });

  const reused = cover.related.find((art) => art.storageId === replacement);
  const uploadShown = upload && (upload.status !== "done" || upload.storageId === replacement);
  const facts = uploadShown ? coverFactsLine(upload.facts) : null;
  const fallback = cover.isbn13
    ? `the jacket fetched for ISBN ${cover.isbn13} when one exists, else the cloth placeholder`
    : "the cloth placeholder";
  const sourceText = chosen?.attribution ?? "";
  // A finished upload the draft no longer holds (Reload latest, Remove): offer it back.
  const restorable = upload?.status === "done" && upload.storageId !== replacement;

  const currentNote = cover.current.missing
    ? "Stored art is missing. Save a replacement or remove the cover."
    : cover.current.url
      ? `Stored art${cover.current.attribution ? `, from ${cover.current.attribution}` : ""}.`
      : `No stored art. The shelf shows ${fallback}.`;

  return (
    <section
      className="mod-panel cover-section"
      aria-labelledby="cover"
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
      }}
    >
      <h2 id="cover" ref={heading} tabIndex={-1}>
        Cover
        {overridden ? <span className="chip mod-chip mod-chip--warn">Human Override</span> : null}
      </h2>
      <p className="section-hint">
        {boxSet
          ? "Art for this box set."
          : `Art for ${cover.label}. The edition and series pages show this jacket when it is the earliest dated release with art.`}
      </p>
      <div className="cover-grid">
        <div className="cover-col">
          <p className="k">Current</p>
          <ArtFrame
            url={cover.current.url}
            alt={`Current cover of ${title}`}
            empty="No stored art"
          />
          <p className="note">{currentNote}</p>
          {cover.mature ? (
            <p className="note">Hidden from readers who have not opted in to 18+ art.</p>
          ) : null}
        </div>
        <div className="cover-col">
          <p className="k">{removed ? "After saving" : "Replacement"}</p>
          {removed ? (
            <ArtFrame url={null} alt={title} empty="No stored art" />
          ) : uploadShown ? (
            <ArtFrame
              url={upload.preview}
              alt={`Replacement cover, ${upload.facts.width} by ${upload.facts.height} pixels`}
              empty="Replacement"
            />
          ) : reused ? (
            <ArtFrame url={reused.url} alt={`Cover from ${reused.label}`} empty="Replacement" />
          ) : (
            <label
              className={over ? "dropzone is-over" : "dropzone"}
              onDragOver={(event) => {
                event.preventDefault();
                setOver(true);
              }}
              onDragLeave={() => setOver(false)}
              onDrop={(event) => {
                event.preventDefault();
                setOver(false);
                const file = event.dataTransfer.files[0];
                if (file) void choose(file);
              }}
            >
              <span>
                <b>Drop a JPEG, PNG or WebP here</b>
                choose a file, or paste an image. Up to 10 MB.
              </span>
              <input
                type="file"
                accept={COVER_TYPES.join(",")}
                disabled={disabled}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) void choose(file);
                }}
              />
            </label>
          )}
          {facts ? (
            <p className="facts">
              {facts.line}
              {facts.cropped ? " · Shelf crop shown; the file is kept whole." : null}
            </p>
          ) : null}
          {removed ? (
            <p className="note">
              After saving, the shelf shows {fallback}. Imports will not attach art again until the
              Human Override on Cover is cleared.
            </p>
          ) : null}
        </div>
      </div>

      <div className="cover-status" aria-live="polite">
        {upload?.status === "uploading" ? <p className="note">Uploading…</p> : null}
        {upload?.status === "done" && uploadShown ? (
          <p className="note">Uploaded. Save to apply it.</p>
        ) : null}
        {upload?.status === "failed" ? (
          <p className="form-error" role="alert">
            {upload.message}{" "}
            <button type="button" className="btn btn-sm" disabled={disabled} onClick={retry}>
              Try again
            </button>
          </p>
        ) : null}
        {problem ? (
          <p className="form-error" role="alert">
            {problem}
          </p>
        ) : null}
      </div>

      {cover.related.length > 0 ? (
        <div className="reuse">
          <p className="k">Reuse related art</p>
          <div className="reuse-row">
            {cover.related.map((art) => {
              const selected = art.storageId === replacement;
              return (
                <button
                  key={art.storageId}
                  type="button"
                  className={selected ? "is-selected" : undefined}
                  aria-pressed={selected}
                  aria-label={`Use the cover from ${art.label}`}
                  disabled={disabled}
                  onClick={() => {
                    abandon();
                    setProblem(null);
                    setValue(
                      encodeCover({ storageId: art.storageId, attribution: art.attribution ?? "" }),
                    );
                  }}
                >
                  <ArtFrame url={art.url} alt={`Cover from ${art.label}`} empty="" />
                  <span>{selected ? "Selected" : art.label.replace(/^the /, "")}</span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      <div className="mod-actions cover-edit-actions">
        {uploadShown || reused ? (
          <>
            <button
              type="button"
              className="btn btn-sm"
              disabled={disabled}
              onClick={() => replaceInput.current?.click()}
            >
              Replace file
            </button>
            <input
              ref={replaceInput}
              type="file"
              hidden
              accept={COVER_TYPES.join(",")}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void choose(file);
              }}
            />
          </>
        ) : null}
        {uploadShown || reused ? (
          <button
            type="button"
            className="btn btn-sm"
            disabled={disabled}
            onClick={() => {
              abandon();
              setUpload(null);
              revert();
            }}
          >
            Discard replacement
          </button>
        ) : null}
        {restorable ? (
          <button
            type="button"
            className="btn btn-sm"
            disabled={disabled}
            onClick={() =>
              setValue(encodeCover({ storageId: upload.storageId, attribution: sourceText }))
            }
          >
            Use the uploaded file again
          </button>
        ) : null}
        {removed ? (
          <button type="button" className="btn btn-sm" disabled={disabled} onClick={revert}>
            Keep current cover
          </button>
        ) : cover.current.storageId !== null ? (
          <button
            type="button"
            className="btn btn-sm"
            disabled={disabled}
            onClick={() => {
              abandon();
              setValue("");
            }}
          >
            Remove cover
          </button>
        ) : null}
      </div>

      <div>
        <label className="cover-source">
          Source
          <input
            value={sourceText}
            disabled={disabled || chosen === null}
            placeholder={chosen === null ? "Choose art first" : "kodansha.us, or a page URL"}
            onChange={(event) => {
              if (chosen) setValue(encodeCover({ ...chosen, attribution: event.target.value }));
            }}
          />
          <span className="field-help">
            Where this art came from, for the record. Leave empty for a scan you made.
          </span>
        </label>
        {!cover.mature && cover.series ? (
          <p className="field-help">
            If this jacket is 18+, set the{" "}
            <Link
              to={proposing ? "/mod/propose/$type/$key" : "/mod/edit/$type/$key"}
              params={{ type: "series", key: String(cover.series.publicId) }}
            >
              series content rating
            </Link>{" "}
            too; covers follow the series rating, not the file.
          </p>
        ) : null}
      </div>
    </section>
  );
}
