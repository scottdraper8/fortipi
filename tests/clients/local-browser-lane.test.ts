import assert from "node:assert/strict";
import test from "node:test";
import { withLocalBrowserLane } from "./local-browser-lane.ts";

type Row = { id: string; outcome: "pass" | "fail"; oracle?: string };

test("LOCAL browser overlaps serial work but publishes only at its original result slot", async () => {
  const releaseBrowser = Promise.withResolvers<void>();
  const browserDone = Promise.withResolvers<void>();
  const serialRunning = Promise.withResolvers<void>();
  const rows: Row[] = [{ id: "distribution-install", outcome: "pass" }];
  const events: string[] = [];
  let finalized = false;
  const running = withLocalBrowserLane(
    async (sink: Row[]) => {
      events.push("browser-enter");
      await releaseBrowser.promise;
      sink.push({ id: "installed-browser", outcome: "pass" });
      events.push("browser-cleanup-done");
      browserDone.resolve();
    },
    async (join) => {
      events.push("serial-enter");
      rows.push({ id: "models-security", outcome: "pass" });
      serialRunning.resolve();
      await browserDone.promise;
      // The actual coordinator uses this last-row association for models-security.
      assert.equal(rows.at(-1)!.id, "models-security");
      rows.at(-1)!.oracle = "model-oracle";
      rows.push({ id: "installed-node-client", outcome: "pass" });
      rows.push(...(await join()));
      rows.push({ id: "independent-python", outcome: "pass" });
      events.push("serial-done");
      return rows;
    },
  ).then((result) => {
    finalized = true;
    events.push("finalize");
    return result;
  });
  await serialRunning.promise;
  assert.deepEqual(events, ["browser-enter", "serial-enter"]);
  assert.equal(finalized, false);
  assert.deepEqual(
    rows.map((row) => row.id),
    ["distribution-install", "models-security"],
  );
  releaseBrowser.resolve();
  assert.equal(await running, rows);
  assert.deepEqual(
    rows.map((row) => row.id),
    [
      "distribution-install",
      "models-security",
      "installed-node-client",
      "installed-browser",
      "independent-python",
    ],
  );
  assert.equal(rows.find((row) => row.id === "models-security")!.oracle, "model-oracle");
  assert.equal(rows.find((row) => row.id === "installed-browser")!.oracle, undefined);
  assert.deepEqual(events.slice(-3), ["browser-cleanup-done", "serial-done", "finalize"]);
});

test("LOCAL browser failure row remains a failure after delayed publication and cleanup", async () => {
  const cleanup = Promise.withResolvers<void>();
  const browserFailed = Promise.withResolvers<void>();
  const rows: Row[] = [];
  let finalized = false;
  const running = withLocalBrowserLane(
    async (sink: Row[]) => {
      sink.push({ id: "installed-browser", outcome: "fail" });
      browserFailed.resolve();
      await cleanup.promise;
    },
    async (join) => {
      rows.push({ id: "installed-node-client", outcome: "pass" });
      rows.push(...(await join()));
      rows.push({
        id: "public-clients",
        outcome: rows.every((r) => r.outcome === "pass") ? "pass" : "fail",
      });
    },
  ).then(() => {
    finalized = true;
  });
  await browserFailed.promise;
  assert.equal(finalized, false);
  assert.equal(
    rows.some((row) => row.id === "installed-browser"),
    false,
  );
  cleanup.resolve();
  await running;
  assert.deepEqual(
    rows.map(({ id, outcome }) => [id, outcome]),
    [
      ["installed-node-client", "pass"],
      ["installed-browser", "fail"],
      ["public-clients", "fail"],
    ],
  );
});

test("LOCAL browser is joined on serial error or early return without replacing the primary error", async () => {
  const cleanupEntered = Promise.withResolvers<void>();
  const cleanupRelease = Promise.withResolvers<void>();
  const primary = Object.freeze({ primary: true });
  const secondary = Object.freeze({ secondary: true });
  let settled = false;
  const running = withLocalBrowserLane(
    async () => {
      try {
        throw secondary;
      } finally {
        cleanupEntered.resolve();
        await cleanupRelease.promise;
      }
    },
    async () => {
      throw primary;
    },
  );
  const checked = running.then(
    () => assert.fail("Serial failure must remain a rejection"),
    (error) => {
      settled = true;
      assert.equal(error, primary);
    },
  );
  await cleanupEntered.promise;
  await Promise.resolve();
  assert.equal(settled, false);
  cleanupRelease.resolve();
  await checked;
  assert.equal(settled, true);

  const finish = Promise.withResolvers<void>();
  let returned = false;
  const early = withLocalBrowserLane(
    async () => {
      await finish.promise;
      throw secondary;
    },
    async () => "serial-return",
  );
  const checkedEarly = early.then(
    () => assert.fail("Unjoined browser rejection must remain a rejection"),
    (error) => {
      returned = true;
      assert.equal(error, secondary);
    },
  );
  await Promise.resolve();
  assert.equal(returned, false);
  finish.resolve();
  await checkedEarly;
});
