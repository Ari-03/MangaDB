// The Cover section's file choices (lib/coverField.tsx) driven with the fake
// React of test.react.ts: a newer choice abandons an upload in flight, so
// Save is never held by an upload whose result will be ignored, whether
// the newer file uploads or is refused.

import { getFunctionName } from "convex/server";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type Host, mount, resetHarness, text } from "./test.react";

const fakes = vi.hoisted(() => ({ uploadUrl: vi.fn(), uploaded: vi.fn() }));

vi.mock("@tanstack/react-router", () => ({ Link: "a" }));
vi.mock("convex/react", () => ({
  useMutation: (ref: Parameters<typeof getFunctionName>[0]) =>
    getFunctionName(ref) === "coverUploads:uploadUrl" ? fakes.uploadUrl : fakes.uploaded,
}));

const { CoverField } = await import("./coverField");

type Props = ComponentProps<typeof CoverField>;

/** The form around the section: its cover value and whether it holds Save. */
function form() {
  const state = { value: "", uploading: false };
  const props: Props = {
    cover: {
      label: "the paperback release",
      isbn13: null,
      current: { url: null, storageId: null, attribution: null, missing: false },
      related: [],
      series: null,
      mature: false,
    },
    boxSet: false,
    title: "Alpha 1",
    value: "",
    initial: "",
    setValue: (value) => {
      state.value = value;
    },
    revert: () => {
      state.value = "";
    },
    onUploading: (uploading) => {
      state.uploading = uploading;
    },
    overridden: false,
    disabled: false,
    proposing: false,
  };
  const render = () => mount(() => CoverField({ ...props, value: state.value }));
  return { state, render };
}

/** Choose `file` through the section's file input, as a person would. */
function choose(tree: Host[], file: File) {
  const input = tree.find((host) => host.type === "input" && host.props.type === "file");
  (input!.props.onChange as (event: unknown) => void)({ target: { files: [file], value: "" } });
}

const png = () => new File([new Uint8Array(4096)], "a.png", { type: "image/png" });
const shows = (tree: Host[], words: string) =>
  tree.some((host) => text(host.props.children).includes(words));

let respond: (response: Response) => void;

beforeEach(() => {
  resetHarness();
  fakes.uploadUrl.mockReset().mockResolvedValue({ uploadId: "u1", url: "https://up.test/1" });
  fakes.uploaded.mockReset().mockResolvedValue({ ok: true });
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise<Response>((resolve) => (respond = resolve))),
  );
  vi.stubGlobal("createImageBitmap", async () => ({ width: 400, height: 600, close() {} }));
  // The section reads the page's anchor on mount (useHashFocus).
  vi.stubGlobal("location", { hash: "" });
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:preview");
  vi.spyOn(URL, "revokeObjectURL").mockReturnValue(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a newer cover choice during an upload", () => {
  it.each([
    ["a GIF", () => new File([new Uint8Array(4096)], "b.gif", { type: "image/gif" })],
    [
      "a file the browser cannot read",
      () => new File([new Uint8Array(4096)], "b.png", { type: "image/png" }),
    ],
    [
      "an image too narrow to shelve",
      () => new File([new Uint8Array(4096)], "b.jpg", { type: "image/jpeg" }),
    ],
  ])("abandons the upload in flight when the new file is %s", async (_, bad) => {
    const { state, render } = form();
    choose(render(), png());
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(state.uploading).toBe(true);
    expect(shows(render(), "Uploading…")).toBe(true);

    const file = bad();
    vi.stubGlobal("createImageBitmap", async () => {
      if (file.name === "b.png") throw new Error("undecodable");
      return { width: 120, height: 180, close() {} };
    });
    choose(render(), file);
    await vi.waitFor(() => expect(render().some((host) => host.props.role === "alert")).toBe(true));
    expect(shows(render(), "Uploading…")).toBe(false);
    expect(state.uploading).toBe(false);

    // The first upload lands late: it is ignored and Save stays free.
    respond(Response.json({ storageId: "late" }));
    await vi.waitFor(() => expect(fakes.uploaded).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.uploading).toBe(false);
    expect(state.value).toBe("");
    expect(shows(render(), "Uploading…")).toBe(false);
  });

  it("lets the newer file's upload alone decide the cover", async () => {
    const { state, render } = form();
    choose(render(), png());
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const first = respond;
    choose(render(), png());
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(state.uploading).toBe(true);

    first(Response.json({ storageId: "stale" }));
    respond(Response.json({ storageId: "fresh" }));
    await vi.waitFor(() => expect(state.uploading).toBe(false));
    expect(JSON.parse(state.value)).toMatchObject({ storageId: "fresh" });
  });
});
