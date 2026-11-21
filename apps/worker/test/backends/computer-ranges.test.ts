import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";
import type { WorkspaceRuntimeResult } from "@cloudflare/computer";
import { freeInfrastructurePolicy } from "fortipi-contract";
import { createTestHarness } from "wrangler";

test("production Codemode range reads preserve bytes, root, cancellation and finite aggregate limits", {
  timeout: 60_000,
}, async (t) => {
  const root = resolve(import.meta.dirname, "../../../..");
  const bytes = Uint8Array.from(
    { length: 512 * 1024 + 73 },
    (_, index) => ((index * 73 + 17) ^ (index >>> 9)) & 255,
  );
  const server = createTestHarness({
    root,
    workers: [
      {
        config: {
          name: "fortipi-computer-ranges",
          main: resolve(root, "apps/worker/test/backends/computer-ranges-worker.ts"),
          compatibility_date: "2026-11-10",
          compatibility_flags: ["nodejs_compat"],
          worker_loaders: [{ binding: "LOADER" }],
          durable_objects: { bindings: [{ name: "RANGES", class_name: "ComputerRangesProbe" }] },
          migrations: [{ tag: "v1", new_sqlite_classes: ["ComputerRangesProbe"] }],
          vars: {
            FORTIPI_CONFIG: {
              version: 1,
              workspace: { kind: "computer" },
              execution: {
                kind: "cloud-js",
                backendId: "ranges",
                modules: [],
                egress: [],
                onInterrupt: "fail",
              },
              routing: { kind: "cloud", targetIds: ["ranges"] },
              models: [],
              infrastructure: {
                ...freeInfrastructurePolicy,
                accountPlan: "paid",
                capabilities: [
                  {
                    capability: "loader",
                    state: "available",
                    accountPlan: "paid",
                    deploymentId: "range-test",
                    observedAt: Date.now(),
                  },
                ],
              },
            },
          },
        },
      },
    ],
  });
  async function run<T>(scenario: string): Promise<T> {
    const response = await server.fetch(`/${scenario}`, { method: "POST", body: bytes });
    assert.equal(response.status, 200);
    const observed = (await response.json()) as {
      result: WorkspaceRuntimeResult<"utf8">;
      outside: string;
      escapeIsLink: boolean;
    };
    assert.equal(observed.outside, "existing-outside-canary");
    assert.equal(observed.escapeIsLink, true);
    assert.equal(observed.result.status, "completed", observed.result.stderr);
    assert.equal(observed.result.exitCode, 0);
    assert.equal(observed.result.sync.status, "complete");
    assert.deepEqual(observed.result.sync.skipped, []);
    assert.deepEqual(observed.result.skipped, []);
    return observed.result.value as T;
  }
  function slice(actual: number[], start: number, end: number): void {
    const expected = bytes.subarray(start, end);
    assert.deepEqual(actual, Array.from(expected));
    const digest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
    assert.equal(digest(Uint8Array.from(actual)), digest(expected));
  }
  try {
    await server.listen();
    await t.test("offsets, short EOF, empty files and cancelled stream handles", async () => {
      const result = await run<{
        size: number;
        guarded: number[];
        rangeBytes: number;
        tail: number[];
        tailBytes: number;
        eofBytes: number;
        emptyBytes: number;
        wholeFileError: string;
        window: number[];
        first: number[];
        cancelledDone: boolean;
        continuation: number[];
        continuedBytes: number;
        closedCode: string;
      }>("reads");
      assert.equal(result.size, bytes.length);
      const guarded = new Uint8Array(16).fill(165);
      guarded.set(bytes.subarray(524283, 524292), 3);
      assert.equal(result.rangeBytes, 9);
      assert.deepEqual(result.guarded, Array.from(guarded));
      slice(result.guarded.slice(3, 12), 524283, 524292);
      assert.equal(result.tailBytes, 3);
      slice(result.tail.slice(0, 3), bytes.length - 3, bytes.length);
      assert.deepEqual(result.tail.slice(3), [165, 165, 165, 165, 165]);
      assert.equal(result.eofBytes, 0);
      assert.equal(result.emptyBytes, 0);
      assert.match(result.wholeFileError, /file read exceeds 262144 bytes/);
      slice(result.window, 65533, 65542);
      slice(result.first, 0, 19);
      assert.equal(result.cancelledDone, true);
      assert.equal(result.continuedBytes, 3);
      slice(result.continuation, 19, 22);
      assert.equal(result.closedCode, "EBADF");
    });
    await t.test("range APIs refuse existing absolute, traversal and symlink escapes", async () => {
      const result = await run<{ path: string; opened: string; streamed: string }[]>("roots");
      assert.deepEqual(
        result.map((entry) => entry.path),
        ["/outside.bin", "../outside.bin", "/workspace/../outside.bin", "escape"],
      );
      for (const entry of result) {
        const reason =
          entry.path === "escape"
            ? /cannot traverse symbolic link \/workspace\/escape/
            : /paths must stay under \/workspace/;
        assert.match(entry.opened, reason);
        assert.match(entry.streamed, reason);
      }
    });
    await t.test(
      "response bytes reach the aggregate boundary before another range call",
      async () => {
        const result = await run<{ counts: number[]; hashes: string[]; message: string }>("bulk");
        // Two requests at 1KiB plus two 127KiB responses exactly fill the 256KiB allowance.
        const expected = createHash("sha256").update(bytes.subarray(65520, 195568)).digest("hex");
        assert.deepEqual(result.counts, [130048, 130048]);
        assert.deepEqual(result.hashes, [expected, expected]);
        assert.equal(result.message, "Workspace execution streams exceed 262144 bytes.");
      },
    );
    for (const scenario of ["tiny", "eof"]) {
      await t.test(
        `${scenario} range calls consume exactly the combined 256KiB allowance`,
        async () => {
          const result = await run<{
            reads: number;
            received: number;
            sum: number;
            lastByte: number;
            message: string;
          }>(scenario);
          // Independently specified: each request and response costs at least 1KiB.
          assert.equal(result.reads, 128);
          assert.equal(result.received, scenario === "tiny" ? 128 : 0);
          assert.equal(result.sum, scenario === "tiny" ? 128 * (bytes[0] ?? 0) : 0);
          assert.equal(result.lastByte, scenario === "tiny" ? bytes[0] : 165);
          assert.equal(result.message, "Workspace execution streams exceed 262144 bytes.");
        },
      );
    }
  } finally {
    await server.close();
  }
});
