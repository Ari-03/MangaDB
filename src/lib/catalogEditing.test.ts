// The Cover and Description sections of the direct-edit form
// (routes/mod.edit.$type.$key.tsx, lib/coverField.tsx,
// lib/descriptionField.tsx) driven as plain functions with the fake React of
// test.react.ts: what a save sends for a description's source, a blurb used
// from a source, and a cover, and the pure helpers behind them.

import { getFunctionName } from "convex/server";
import { type ComponentProps, isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { harness, resetHarness } from "./test.react";

const KODANSHA = { sourceName: "Kodansha USA", url: "https://kodansha.us/alpha-1" };

const fakes = vi.hoisted(() => ({
  form: null as Record<string, unknown> | null,
  blurbs: null as Record<string, unknown> | null,
  submit: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({
    options,
    useParams: () => ({ type: "release", key: "rel-1" }),
  }),
  Link: "a",
  useNavigate: () => fakes.navigate,
}));
vi.mock("convex/react", () => ({
  useQuery: (ref: Parameters<typeof getFunctionName>[0]) => {
    const name = getFunctionName(ref);
    if (name === "users:viewer") return { username: "mod" };
    if (name === "moderation:sourceBlurbs") return fakes.blurbs;
    return fakes.form;
  },
  useMutation: () => fakes.submit,
}));
vi.mock("~/lib/viewer", () => ({ useIsModerator: () => true, useIsDataTeam: () => true }));

const { Route } = await import("../routes/mod.edit.$type.$key");
const { CoverField, coverFactsLine, coverFileProblem } = await import("./coverField");
const { DescriptionField } = await import("./descriptionField");
const { decodeCover, draftCitation, encodeCover } = await import("./editForm");

/** The editForm answer for a Release whose blurb Kodansha supplied and whose cover was imported. */
function releaseForm() {
  return {
    fields: [
      { name: "price", label: "Price", kind: "price", value: null },
      {
        name: "description",
        label: "Release description",
        kind: "textarea",
        editorial: true,
        value: "A girl finds a sword.",
      },
      {
        name: "coverImage",
        label: "Cover",
        kind: "image",
        editorial: true,
        value: { storageId: "old", attribution: "Kodansha" },
      },
    ],
    ref: { type: "release", id: "rel-1" },
    baseRevisionId: "r1",
    importReviewPending: false,
    status: "active",
    locked: false,
    title: "Alpha 1",
    overriddenFields: [],
    overrides: [],
    backLink: null,
    attribution: KODANSHA,
    cover: {
      label: "the paperback release, ISBN 9781632364210",
      isbn13: "9781632364210",
      current: {
        url: "https://cdn.test/old.jpg",
        storageId: "old",
        attribution: "Kodansha",
        missing: false,
      },
      related: [],
      series: { publicId: 1, title: "Alpha" },
      mature: false,
    },
  };
}

function blurb(text: string, url: string | null = "https://ann.test/9") {
  return {
    observationId: "obs-ann",
    sourceKey: "ann",
    sourceName: "Anime News Network Encyclopedia",
    url,
    lastSeenAt: 1000,
    withdrawn: false,
    text,
    current: false,
    recordedOnly: null,
  };
}

type Node = ReactElement<Record<string, unknown>>;
function nodes(node: ReactNode): Node[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...nodes(node.props.children as ReactNode)];
}
const call = (node: Node) =>
  (node.type as (props: Record<string, unknown>) => ReactNode)(node.props);

/**
 * Render page → gate → form, then the Description section and its source
 * list inside it, in one hook order. The Cover section is found but not
 * rendered: its props are the form's wiring.
 */
function render() {
  const page = (Route.options.component as () => Node)();
  const gate = call(page) as Node;
  harness.cursor = 0;
  const form = nodes(call(gate));
  const description = form.find((node) => node.type === DescriptionField)!;
  const section = nodes(call(description));
  const list = section.find((node) => node.props.recordRef !== undefined)!;
  const blurbs = nodes(call(list));
  const all = [...form, ...section, ...blurbs];
  const button = (label: string) =>
    all.find((node) => node.type === "button" && node.props.children === label);
  return {
    cover: form.find((node) => node.type === CoverField)!,
    description,
    form: form.find((node) => node.type === "form")!,
    submit: form.find((node) => node.type === "button" && node.props.type === "submit")!,
    comment: form.filter((node) => node.type === "textarea").at(-1)!,
    text: section.find((node) => node.type === "textarea")!,
    radios: section.filter((node) => node.type === "input" && node.props.type === "radio"),
    button,
    all,
  };
}

function save(comment = "Copy edit.") {
  (render().comment.props.onChange as (event: unknown) => void)({ target: { value: comment } });
  (render().form.props.onSubmit as (event: unknown) => void)({ preventDefault() {} });
}
const typeText = (value: string) =>
  (render().text.props.onChange as (event: unknown) => void)({ target: { value } });
const click = (label: string) => (render().button(label)!.props.onClick as () => void)();

beforeEach(() => {
  resetHarness();
  fakes.form = releaseForm();
  fakes.blurbs = {
    field: "description",
    canonical: { text: "A girl finds a sword.", author: null, overridden: false },
    blurbs: [blurb("ANN's summary.")],
    truncated: false,
  };
  fakes.submit.mockReset().mockResolvedValue({ seq: 2 });
  fakes.navigate.mockReset().mockResolvedValue(undefined);
});

describe("the Description section", () => {
  it("keeps the current source through a light copy edit", async () => {
    typeText("A girl finds a sword!");
    save();
    await vi.waitFor(() => expect(fakes.submit).toHaveBeenCalled());
    expect(fakes.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        changes: [{ field: "description", value: "A girl finds a sword!" }],
        citation: KODANSHA,
        evidence: [],
      }),
    );
  });

  it("fills the text and its source from a blurb, citing the record as evidence", async () => {
    click("Use this description");
    expect(render().text.props.value).toBe("ANN's summary.");
    expect(render().button("In use")).toBeTruthy();
    save();
    await vi.waitFor(() => expect(fakes.submit).toHaveBeenCalled());
    expect(fakes.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        changes: [{ field: "description", value: "ANN's summary." }],
        citation: { sourceName: "Anime News Network Encyclopedia", url: "https://ann.test/9" },
        evidence: [{ kind: "observation", observationId: "obs-ann" }],
      }),
    );
  });

  it("asks before replacing unsaved text, and keeps it when told to", () => {
    typeText("My own words.");
    click("Use this description");
    expect(render().text.props.value).toBe("My own words.");
    click("Keep mine");
    expect(render().text.props.value).toBe("My own words.");
    click("Use this description");
    click("Replace");
    expect(render().text.props.value).toBe("ANN's summary.");
  });

  it("refuses to save another page without an https URL", async () => {
    typeText("Rewritten.");
    // Keep, Another page, Original prose: the second radio names a page.
    (render().radios[1]!.props.onChange as () => void)();
    const input = (placeholder: string) =>
      render().all.find(
        (node) => node.type === "input" && String(node.props.placeholder).startsWith(placeholder),
      )!;
    (input("Kodansha USA").props.onChange as (event: unknown) => void)({
      target: { value: "Blog" },
    });
    (input("https://").props.onChange as (event: unknown) => void)({
      target: { value: "http://blog.test" },
    });
    save();
    await vi.waitFor(() =>
      expect(
        render().all.some(
          (node) =>
            node.props.className === "form-error" &&
            String(node.props.children).startsWith("Add the page"),
        ),
      ).toBe(true),
    );
    expect(fakes.submit).not.toHaveBeenCalled();
  });

  it("states no external source when Original prose is chosen", async () => {
    (render().radios.at(-1)!.props.onChange as () => void)();
    expect(render().radios.at(-1)!.props.checked).toBe(true);
    save();
    await vi.waitFor(() => expect(fakes.submit).toHaveBeenCalled());
    expect(fakes.submit).toHaveBeenCalledWith(
      expect.objectContaining({ changes: [], citation: null }),
    );
  });
});

describe("the Cover section", () => {
  it("saves the newest cover as a change and holds Save while uploading", async () => {
    const cover = () => render().cover.props as unknown as ComponentProps<typeof CoverField>;
    cover().onUploading(true);
    expect(render().submit.props.disabled).toBe(true);
    expect(render().submit.props.children).toBe("Uploading…");
    cover().setValue(encodeCover({ storageId: "new", attribution: "kodansha.us" }));
    cover().onUploading(false);
    save("New jacket.");
    await vi.waitFor(() => expect(fakes.submit).toHaveBeenCalled());
    expect(fakes.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        changes: [{ field: "coverImage", value: { storageId: "new", attribution: "kodansha.us" } }],
        citation: undefined,
      }),
    );
  });

  it("puts the stored cover back untouched, leaving nothing to save", () => {
    const cover = () => render().cover.props as unknown as ComponentProps<typeof CoverField>;
    cover().setValue("");
    expect(render().cover.props.value).toBe("");
    cover().revert();
    expect(render().cover.props.value).toBe(render().cover.props.initial);
    (render().comment.props.onChange as (event: unknown) => void)({ target: { value: "x" } });
    expect(render().submit.props.disabled).toBe(true);
  });
});

describe("cover and source helpers", () => {
  it("checks a chosen file as the server will", () => {
    expect(coverFileProblem({ type: "image/gif", size: 50_000 })).toMatch(/Only JPEG, PNG or WebP/);
    expect(coverFileProblem({ type: "image/jpeg", size: 11 * 1024 * 1024 })).toMatch(/Over 10 MB/);
    expect(coverFileProblem({ type: "image/png", size: 100 })).toMatch(/placeholder/);
    expect(coverFileProblem({ type: "image/webp", size: 50_000 }, 299)).toMatch(/300 px/);
    expect(coverFileProblem({ type: "image/webp", size: 50_000 }, 300)).toBeNull();
  });

  it("describes a file and whether the shelf crops it", () => {
    expect(
      coverFactsLine({ width: 1400, height: 2100, size: 612 * 1024, type: "image/jpeg" }),
    ).toEqual({
      line: "1400 × 2100 px · 612 KB · JPEG",
      cropped: false,
    });
    expect(
      coverFactsLine({ width: 1000, height: 1000, size: 2 * 1024 * 1024, type: "image/png" })
        .cropped,
    ).toBe(true);
  });

  it("round-trips a cover through form state", () => {
    expect(decodeCover(encodeCover({ storageId: "s", attribution: "a" }))).toEqual({
      storageId: "s",
      attribution: "a",
    });
    expect(decodeCover(encodeCover(null))).toBeNull();
  });

  it("says nothing about the source unless the text or its source was touched", () => {
    const field = {
      name: "description",
      label: "Description",
      kind: "textarea" as const,
      editorial: true,
    };
    const values = { description: "Text." };
    expect(draftCitation(field, values, new Set(["price.amount"]), KODANSHA)).toEqual({
      ok: true,
      citation: undefined,
      evidence: [],
    });
    expect(
      draftCitation(field, { description: "  " }, new Set(["description"]), KODANSHA),
    ).toMatchObject({
      citation: null,
    });
    expect(
      draftCitation(
        field,
        {
          ...values,
          "description.source": "custom",
          "description.sourceName": "Blog",
          "description.sourceUrl": "http://x.test",
        },
        new Set(["description.source"]),
        null,
      ),
    ).toEqual({ ok: false, message: "Add the page the text came from, or choose Original prose." });
  });
});
