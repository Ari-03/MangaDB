import { describe, expect, it, vi } from "vitest";
import { applyRetrying, isWriteConflict } from "./occ";

// The mutation reference is only forwarded to ctx.runMutation, so a stub is enough.
const ref = {} as Parameters<typeof applyRetrying>[1];
const conflict = () =>
  new Error(
    'Documents read from or written to the "counters" table changed while this mutation was being run and on every subsequent retry.',
  );

describe("applyRetrying", () => {
  it("recognizes Convex's exhausted write-conflict message", () => {
    expect(isWriteConflict(conflict())).toBe(true);
    expect(isWriteConflict(new Error("HTTP 403"))).toBe(false);
  });

  it("retries a write conflict and returns the eventual result", async () => {
    vi.useFakeTimers();
    const runMutation = vi
      .fn()
      .mockRejectedValueOnce(conflict())
      .mockRejectedValueOnce(conflict())
      .mockResolvedValue({ changed: true });
    const pending = applyRetrying({ runMutation }, ref, { x: 1 });
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toEqual({ changed: true });
    expect(runMutation).toHaveBeenCalledTimes(3);
    expect(runMutation).toHaveBeenLastCalledWith(ref, { x: 1 });
    vi.useRealTimers();
  });

  it("gives up after the configured attempts", async () => {
    vi.useFakeTimers();
    const runMutation = vi.fn().mockRejectedValue(conflict());
    const pending = applyRetrying({ runMutation }, ref, {}, 3);
    pending.catch(() => {});
    await vi.runAllTimersAsync();
    await expect(pending).rejects.toThrow(/changed while this mutation/);
    expect(runMutation).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it("rethrows anything that is not a write conflict without retrying", async () => {
    const runMutation = vi.fn().mockRejectedValue(new Error("HTTP 403"));
    await expect(applyRetrying({ runMutation }, ref, {})).rejects.toThrow("HTTP 403");
    expect(runMutation).toHaveBeenCalledTimes(1);
  });
});
