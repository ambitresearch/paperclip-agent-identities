import { describe, expect, it } from "vitest";
import { withProcessLocalLocks } from "../src/core/process-local-mutation-queue.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("process-local mutation queue", () => {
  it("does not poison a key after a failed operation", async () => {
    const owner = {};
    const entered = deferred();
    const release = deferred();
    const first = withProcessLocalLocks(owner, ["key"], async () => {
      entered.resolve();
      await release.promise;
      throw new Error("expected failure");
    });
    await entered.promise;

    let secondRan = false;
    const second = withProcessLocalLocks(owner, ["key"], async () => {
      secondRan = true;
      return "ok";
    });
    await Promise.resolve();
    expect(secondRan).toBe(false);

    release.resolve();
    await expect(first).rejects.toThrow("expected failure");
    await expect(second).resolves.toBe("ok");
  });
});
