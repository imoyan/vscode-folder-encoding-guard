import assert from "node:assert/strict";
import test from "node:test";
import { CoalescingTask, SerialTaskQueue } from "../src/coalescingTask.js";

test("coalesces repeated requests into one pending rerun", async () => {
  const scheduler = new CoalescingTask();
  let runs = 0;
  let release: (() => void) | undefined;
  const first = scheduler.run(async () => {
    runs += 1;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  await Promise.resolve();
  const second = scheduler.run(async () => {
    runs += 1;
  });
  const third = scheduler.run(async () => {
    runs += 1;
  });
  assert.equal(second, third);
  release?.();
  await Promise.all([first, second, third]);
  assert.equal(runs, 2);
});

test("starts a queued request after the active request rejects", async () => {
  const scheduler = new CoalescingTask();
  let rejectFirst: ((error: Error) => void) | undefined;
  let recovered = false;
  const first = scheduler.run(
    () => new Promise<void>((_resolve, reject) => {
      rejectFirst = reject;
    }),
  );
  await Promise.resolve();
  const second = scheduler.run(async () => {
    recovered = true;
  });
  rejectFirst?.(new Error("failed"));
  await assert.rejects(first, /failed/);
  await second;
  assert.equal(recovered, true);
});

test("serializes settings mutations after a rejected mutation", async () => {
  const queue = new SerialTaskQueue();
  const order: string[] = [];
  const failed = queue.run(async () => {
    order.push("first");
    throw new Error("failed");
  });
  const recovered = queue.run(async () => {
    order.push("second");
    return 2;
  });
  await assert.rejects(failed, /failed/);
  assert.equal(await recovered, 2);
  assert.deepEqual(order, ["first", "second"]);
});

 test("keeps the queued handoff occupied when a completion handler submits work", async () => {
  const scheduler = new CoalescingTask();
  let runs = 0;
  let late: Promise<void> | undefined;
  const task = async () => { runs += 1; await Promise.resolve(); };
  const first = scheduler.run(task);
  void first.then(() => { late = scheduler.run(task); });
  const queued = scheduler.run(task);
  await first;
  await queued;
  await late;
  assert.equal(runs, 2);
});
