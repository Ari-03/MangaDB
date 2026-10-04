// A fake React for driving components as plain functions under vitest's
// edge runtime, which has no DOM. Importing this file mocks `react`:
// useState, useRef and useMemo keep each component's values in
// `harness.slots` across renders, useEffect queues its effect for `mount`
// to run once the render is done (again only when a dependency changed),
// and useSyncExternalStore reads the store's snapshot directly, recording
// the subscribe function it was handed. `backendHooks` is a convex/react
// whose useQuery answers from `harness.snapshot` and whose useMutation runs
// against the convex-test `harness.backend`. A suite opts into it with
//
//   vi.mock("convex/react", async () => (await import("./test.react")).backendHooks);
//
// and imports the components under test with `await import(...)` after
// this file. Test-only: the name stays outside vitest's include
// (**/*.test.ts) and no app code imports it.

import { getFunctionName, type FunctionReference } from "convex/server";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { vi } from "vitest";

import type { Accessor } from "../../convex/test.helpers";

/**
 * State shared with the mocks: the signed-in backend, the query snapshot
 * useQuery answers from, an optional wrapper around every mutation call
 * (see hold), the in-flight mutation promises, the hook slots of the
 * component being rendered with its cursor, the effects the render queued,
 * and the last subscribe an external store was read with. Hoisted, so the
 * react mock can use it (and exported under another name, as vitest cannot
 * export a hoisted binding).
 */
const state = vi.hoisted(() => ({
  backend: null as Accessor | null,
  intercept: null as ((name: string, run: () => Promise<unknown>) => Promise<unknown>) | null,
  snapshot: new Map<string, unknown>(),
  inflight: [] as Array<Promise<unknown>>,
  slots: [] as unknown[],
  cursor: 0,
  effects: [] as Array<() => void>,
  subscribe: null as ((listener: () => void) => () => void) | null,
}));
export const harness = state;

// useState backed by slots that survive re-renders of the same component (a
// setter keeps writing the slots it was rendered with, so a component
// mounted aside keeps its own).
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  function useState<S>(initial: S | (() => S)) {
    const slots = state.slots;
    const index = state.cursor++;
    if (!(index in slots)) {
      slots[index] = typeof initial === "function" ? (initial as () => S)() : initial;
    }
    const set = (next: S | ((prev: S) => S)) => {
      slots[index] =
        typeof next === "function" ? (next as (prev: S) => S)(slots[index] as S) : next;
    };
    return [slots[index] as S, set] as const;
  }
  // Whether a hook's `deps` differ from those stored in its slot (always
  // on its first render, and every render without deps).
  const changed = (index: number, deps?: readonly unknown[]) => {
    const prev = (state.slots[index] as { deps?: readonly unknown[] } | undefined)?.deps;
    return (
      !prev ||
      !deps ||
      prev.length !== deps.length ||
      deps.some((dep, i) => !Object.is(dep, prev[i]))
    );
  };
  // biome-ignore lint/suspicious/noConfusingVoidType: mirrors React's EffectCallback, which returns void or a destructor
  function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]) {
    const slots = state.slots;
    const index = state.cursor++;
    if (!changed(index, deps)) return;
    const prev = slots[index] as { cleanup?: () => void } | undefined;
    const slot: { deps?: readonly unknown[]; cleanup?: () => void } = { deps };
    slots[index] = slot;
    state.effects.push(() => {
      prev?.cleanup?.();
      slot.cleanup = effect() ?? undefined;
    });
  }
  function useMemo<T>(create: () => T, deps: readonly unknown[]) {
    const index = state.cursor++;
    if (changed(index, deps)) state.slots[index] = { deps, value: create() };
    return (state.slots[index] as { value: T }).value;
  }
  function useRef<T>(initial: T) {
    const index = state.cursor++;
    if (!(index in state.slots)) state.slots[index] = { current: initial };
    return state.slots[index] as { current: T };
  }
  function useSyncExternalStore<T>(
    subscribe: (listener: () => void) => () => void,
    snapshot: () => T,
  ) {
    state.subscribe = subscribe;
    return snapshot();
  }
  return { ...actual, useState, useEffect, useMemo, useRef, useSyncExternalStore };
});

/** convex/react wired to the harness: queries from the snapshot, mutations to the backend. */
export const backendHooks = {
  useQuery: (ref: FunctionReference<"query">) => harness.snapshot.get(getFunctionName(ref)),
  useMutation: (ref: FunctionReference<"mutation">) => (args: Record<string, unknown>) => {
    const run = () => harness.backend!.mutation(ref, args);
    const call = harness.intercept ? harness.intercept(getFunctionName(ref), run) : run();
    harness.inflight.push(call);
    return call;
  },
};

/** Clear the harness between tests. */
export function resetHarness() {
  harness.backend = null;
  harness.intercept = null;
  harness.snapshot.clear();
  harness.inflight = [];
  harness.slots = [];
  harness.cursor = 0;
  harness.effects = [];
  harness.subscribe = null;
}

/** Answer `ref`'s useQuery with `value` from now on. */
export function setQuery(ref: FunctionReference<"query">, value: unknown) {
  harness.snapshot.set(getFunctionName(ref), value);
}

export type Host = { type: string; props: { children?: ReactNode } & Record<string, unknown> };

/** Expand function components into the host elements they render. */
export function render(node: ReactNode): Host[] {
  if (Array.isArray(node)) return node.flatMap(render);
  if (!isValidElement(node)) return [];
  const { type, props } = node as ReactElement<Host["props"]>;
  if (typeof type === "function") {
    return render((type as (props: Host["props"]) => ReactNode)(props));
  }
  if (typeof type === "string") return [{ type, props }, ...render(props.children)];
  return render(props.children);
}

/**
 * Render a root component with a fresh hook cursor (slots persist), then
 * run the effects the render queued.
 */
export function mount(component: () => ReactNode): Host[] {
  harness.cursor = 0;
  const tree = render(component());
  for (const effect of harness.effects.splice(0)) effect();
  return tree;
}

/**
 * Render a root component on its own hook slots (another control on the
 * page), leaving the current ones in place.
 */
export function mountAside(slots: unknown[], component: () => ReactNode): Host[] {
  const current = harness.slots;
  harness.slots = slots;
  try {
    return mount(component);
  } finally {
    harness.slots = current;
  }
}

/** The text a node renders. */
export function text(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return text(node.props.children);
  return "";
}

/**
 * The button reading `label` (or labelled it), whether or not it renders
 * disabled: `click` runs its handler, a click the handler must refuse when
 * `disabled`.
 */
export function press(tree: Host[], label: string) {
  const button = tree.find(
    (host) =>
      host.type === "button" &&
      (text(host.props.children) === label || host.props["aria-label"] === label),
  );
  if (!button) throw new Error(`No button "${label}"`);
  const onClick = button.props.onClick as () => void;
  return { disabled: button.props.disabled === true, click: () => onClick() };
}

/** Click the button reading `label`. */
export function click(tree: Host[], label: string) {
  press(tree, label).click();
}

/** Wait until every mutation the clicks started (and whatever they start) settles. */
export async function settle() {
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (harness.inflight.length === 0) return;
    await Promise.allSettled(harness.inflight.splice(0));
  }
}

/** Like settle(), but leaves the first `held` in-flight calls alone. */
export async function settleBesides(held: number) {
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const rest = harness.inflight.splice(held);
    if (rest.length === 0) return;
    await Promise.allSettled(rest);
  }
}

/**
 * Hold the `nth` call of one mutation, either just before it runs or just
 * after it commits (its response withheld): `reached` resolves at that
 * point, `release` lets it continue.
 */
export function hold(name: string, nth: number, when: "before" | "after") {
  let release!: () => void;
  let reach!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const reached = new Promise<void>((resolve) => (reach = resolve));
  let calls = 0;
  harness.intercept = async (called, run) => {
    const held = called === name && ++calls === nth;
    if (held && when === "before") {
      reach();
      await gate;
    }
    const result = await run();
    if (held && when === "after") {
      reach();
      await gate;
    }
    return result;
  };
  return { reached, release };
}
