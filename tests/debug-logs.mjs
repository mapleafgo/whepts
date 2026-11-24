import assert from "node:assert/strict";
import { test } from "node:test";
import Whep from "../dist/index.js";

test("debug failure logs identify the player and connection attempt", async (t) => {
  const debug = t.mock.method(console, "debug", () => {});
  const warn = t.mock.method(console, "warn", () => {});
  t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 503 }));
  const player = new Whep({
    url: "https://fixture.invalid/whep",
    lazyLoad: false,
    container: { srcObject: null, addEventListener() {}, removeEventListener() {} },
  });
  t.after(() => player.close());
  await new Promise((resolve) => player.once("error", resolve));
  await player.scheduler.runTask(
    {
      id: "fixture",
      callback() {
        throw new Error("private detail");
      },
    },
    0,
  );
  const [, failure] = warn.mock.calls.find(
    ({ arguments: args }) => args[0] === "[WhepTS] Player error",
  ).arguments;
  const [label, task] = debug.mock.calls.find(({ arguments: args }) =>
    args[0].toLowerCase().endsWith("task failed"),
  ).arguments;
  assert.equal(label, "[WhepTS] Monitor task failed");
  assert.equal(task.playerId, failure.playerId);
  assert.equal(failure.attemptId, 1);
  assert.ok(Number.isFinite(failure.elapsedMs) && failure.elapsedMs >= 0);
  assert.doesNotMatch(JSON.stringify([task, failure]), /fixture\.invalid|private detail/);
});
