import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "@babel/parser";
import type * as D from "../../src/boundary/dto.js";
import type { NativeRecoveryContext, nativeProcessRecovery } from "../execution/native-process.ts";
import { verifyNativeReconciliation } from "../execution/native-reconciliation.ts";
import { poll } from "./runtime.ts";

/** Reuse the earned real service recovery seam. Only its test command's external
 * marker is strengthened to fsync a fresh nonce before reporting a start. */
async function recoveryPort() {
  const path = resolve(import.meta.dirname, "../execution/native-process.ts"),
    source = await readFile(path, "utf8");
  const ast = parse(source, { sourceType: "module", plugins: ["typescript"] });
  const edits: { start: number; end: number; text: string }[] = [];
  let markers = 0;
  function walk(value: unknown) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    const node = value as { type?: string; start?: number; end?: number; [key: string]: unknown };
    if (node.type === "TemplateLiteral" && node.start !== undefined && node.end !== undefined) {
      const text = source.slice(node.start, node.end);
      if (text.includes("changed after service loss") && text.includes("appendFileSync")) {
        markers++;
        const from = "import{appendFileSync,existsSync,writeFileSync}from'node:fs';appendFileSync(";
        assert.equal(text.split(from).length, 2);
        edits.push({
          start: node.start,
          end: node.end,
          text: text.replace(
            from,
            "import{appendFileSync,existsSync,writeFileSync,openSync,fsyncSync,closeSync}from'node:fs';const persist=(path,text)=>{appendFileSync(path,text.replace('start','start:'+globalThis.crypto.randomUUID()));const fd=openSync(path,'r+');try{fsyncSync(fd)}finally{closeSync(fd)}};persist(",
          ),
        });
        return;
      }
    }
    for (const [key, child] of Object.entries(node))
      if (!["loc", "comments", "tokens"].includes(key)) walk(child);
  }
  walk(ast);
  assert.equal(markers, 1, "Exactly one existing test marker producer must be instrumented");
  for (const node of ast.program.body)
    if (node.type === "ImportDeclaration") {
      assert.ok(
        node.source.start !== null &&
          node.source.start !== undefined &&
          node.source.end !== null &&
          node.source.end !== undefined,
      );
      edits.push({
        start: node.source.start,
        end: node.source.end,
        text: JSON.stringify(
          node.source.value.startsWith(".")
            ? pathToFileURL(resolve(dirname(path), node.source.value)).href
            : import.meta.resolve(node.source.value),
        ),
      });
    }
  let copy = source;
  for (const edit of edits.sort((a, b) => b.start - a.start))
    copy = copy.slice(0, edit.start) + edit.text + copy.slice(edit.end);
  const directory = await mkdtemp(resolve(tmpdir(), "fortipi-integration-recovery-")),
    file = resolve(directory, "recovery.ts");
  await writeFile(file, copy, { flag: "wx", mode: 0o600 });
  let module: { nativeProcessRecovery: typeof nativeProcessRecovery };
  try {
    module = await import(pathToFileURL(file).href);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    run: module.nativeProcessRecovery,
    sourceSha256: createHash("sha256").update(source).digest("hex"),
    markerProducerSha256: createHash("sha256")
      .update(edits.find((edit) => edit.text.includes("fsyncSync"))!.text)
      .digest("hex"),
    async close() {
      assert.equal(await readFile(path, "utf8"), source);
      await rm(directory, { recursive: true, force: true });
    },
  };
}
async function marker(context: NativeRecoveryContext) {
  const bytes = await readFile(context.marker, "utf8");
  const starts = [...bytes.matchAll(/start:([a-f0-9-]{36})/g)];
  assert.equal(
    starts.length,
    1,
    "Actual fsynced nonce must identify exactly one physical native start",
  );
  return { starts: starts.length, markerSha256: createHash("sha256").update(bytes).digest("hex") };
}
export async function dispatchRecovery() {
  const port = await recoveryPort(),
    boundaries: Record<string, unknown>[] = [];
  try {
    for (const mode of ["seed", "attached", "receipt"] as const) {
      let observed = false;
      await port.run(mode, "agent-first", {
        outage: "natural",
        verify: async (context) => {
          boundaries.push({
            boundary: mode,
            jobId: context.job.jobId,
            executionId: context.identity.executionId,
            childIds: context.children,
            ...(await marker(context)),
          });
          observed = true;
          return "continue";
        },
      });
      assert.equal(observed, true);
    }
    return {
      boundaries,
      actualRecoveryScenarioCompleted: true,
      sourceSha256: port.sourceSha256,
      markerProducerSha256: port.markerProducerSha256,
      unchangedSource: true,
      limitations: [
        "Real local service SIGKILL and unchanged native host; no cloud eviction or separate-device proof",
      ],
    };
  } finally {
    await port.close();
  }
}
export async function approvalReconciliation() {
  const port = await recoveryPort();
  let observation: Record<string, unknown> | undefined;
  try {
    await port.run("assign-ack", "agent-first", {
      outage: "until-uncertain",
      verify: async (context) => {
        await verifyNativeReconciliation(context, "assign-ack");
        const original = await context.service.api<D.Job>(
          `/v1/jobs/${context.job.jobId}`,
          undefined,
          "GET",
          context.actorToken,
        );
        assert.equal(original.status, 200);
        assert.equal(original.body.state, "requires_reconciliation");
        const input: D.ReconcileInput = {
          requestId: randomUUID(),
          expectedVersion: original.body.version,
          reason: "seed1010 explicitly authorize a separate operation",
          action: { kind: "new-job", authorizationId: randomUUID() },
        };
        const next = await context.service.api<D.ReconcileReceipt>(
          `/v1/jobs/${context.job.jobId}/reconcile`,
          input,
          "POST",
          context.actorToken,
        );
        assert.equal(next.status, 202);
        assert.ok(next.body.newJobId);
        assert.notEqual(next.body.newJobId, context.job.jobId);
        assert.deepEqual(
          await context.service.api(
            `/v1/jobs/${context.job.jobId}/reconcile`,
            input,
            "POST",
            context.actorToken,
          ),
          next,
        );
        const fresh = await poll(
          async () =>
            (
              await context.service.api<D.Job>(
                `/v1/jobs/${next.body.newJobId}`,
                undefined,
                "GET",
                context.actorToken,
              )
            ).body,
          (job) => job.state === "awaiting_approval",
        );
        assert.equal(
          fresh.execution,
          undefined,
          "Explicit new identity still requires its own remote/native consent",
        );
        const after = await context.service.api<D.Job>(
          `/v1/jobs/${context.job.jobId}`,
          undefined,
          "GET",
          context.actorToken,
        );
        assert.equal(after.body.state, "requires_reconciliation");
        observation = {
          originalJobId: original.body.jobId,
          originalUncertaintyPreserved: true,
          newAuthorizedJobId: fresh.jobId,
          freshApprovalRequired: true,
          ...(await marker(context)),
          actualChildIds: (await context.view()).tasks
            .filter((task) => task.kind === "fortipi.dispatch")
            .map((task) => task.id),
        };
      },
    });
    assert.ok(observation);
    return {
      ...observation,
      sourceSha256: port.sourceSha256,
      markerProducerSha256: port.markerProducerSha256,
      limitations: [
        "Acknowledged local service loss with actual CP offline uncertainty; no platform eviction or automatic side-effect retry",
      ],
    };
  } finally {
    await port.close();
  }
}
