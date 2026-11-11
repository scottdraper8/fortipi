import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { assignmentDigest, operationDigest } from "fortipi-contract";
import type * as D from "../../src/boundary/dto.js";
import { harness } from "./harness.ts";

async function runFixture(source?: string, denied = false): Promise<void> {
  const server = harness(true);
  async function call<T>(input: unknown): Promise<T> {
    const response = await server.fetch("/rpc", { method: "POST", body: JSON.stringify(input) });
    const result = (await response.json()) as D.Outcome<T>;
    if (!result.ok) assert.fail(JSON.stringify(result));
    return result.value;
  }
  try {
    await server.listen();
    const seeded = (await (await server.fetch("/seed")).json()) as D.Outcome<D.WorkspaceBinding>;
    if (!seeded.ok) assert.fail(JSON.stringify(seeded));
    const operationContext: D.OperationContext = {
      deploymentId: "test-deployment",
      agentId: "agent",
      conversationId: "conversation",
      policyVersion: 1,
    };
    const args = {
      source:
        source ??
        "import {readFile,writeFile} from 'node:fs/promises'; export default async function(){let count=0;try{count=Number(await readFile('/workspace/run-count.txt','utf8'));}catch{} await writeFile('/workspace/run-count.txt',String(count+1),{mode:420});let denials=0; for(const path of ['/.fortipi/output/stdout','/etc/passwd','/workspace/../escape'])try{await readFile(path);}catch{denials++;}try{await fetch('https://example.invalid/');}catch{denials++;} if(denials!==4)throw new Error('Confinement probe escaped'); await writeFile('/workspace/confinement.txt',String(denials));console.log('x'.repeat(40000));}",
    };
    const deadline = Date.now() + 30_000;
    const operation: D.OperationDigestInput = {
      ...operationContext,
      tool: "javascript",
      arguments: args,
      workspaceId: "workspace",
      baseRevision: seeded.value.revision,
      target: { kind: "backend", backendId: "backend", generation: 1 },
      grantVersion: 1,
      deadline,
    };
    const digest = await operationDigest(operation);
    const target: D.TargetRequest = {
      ownerKind: "job",
      operationId: "cloud-operation",
      operationDigest: digest,
      workspaceId: "workspace",
      bindingVersion: 1,
      target: operation.target,
      actions: ["workspace.write"],
      jobId: "cloud-job",
      agentId: "agent",
      conversationId: "conversation",
      deadline,
      expiresAt: deadline,
    };
    const reservation = await call<D.TargetReservation>({ kind: "reservation", input: target });
    const lease = await call<D.Lease>({ kind: "acquire", input: target });
    const identity: D.ExecutionIdentity = {
      jobId: "cloud-job",
      executionId: "cloud-execution",
      operationDigest: digest,
      assignmentDigest: await assignmentDigest({
        operation,
        executionId: "cloud-execution",
        reservationId: reservation.reservationId,
        leaseId: lease.leaseId,
        fence: lease.fence,
        executorGeneration: lease.executorGeneration,
      }),
      target: operation.target,
      lease,
      baseRevision: lease.baseRevision,
      deadline,
    };
    const prepared = await call<D.PreparedExecution>({
      kind: "prepare-execution",
      input: {
        reservation,
        operationContext,
        identity,
        tool: operation.tool,
        arguments: args,
        workspaceId: "workspace",
        bindingVersion: 1,
        capabilities: ["javascript", "workspace.write"],
      },
    });
    const starts = await Promise.all([
      call<D.ExecutionObservation>({ kind: "start-execution", input: prepared }),
      call<D.ExecutionObservation>({ kind: "start-execution", input: prepared }),
    ]);
    assert.ok(starts.every((result) => result.identity.executionId === identity.executionId));
    if (denied) {
      assert.equal(
        (await call<D.ExecutionObservation>({ kind: "query-execution", input: identity })).state,
        "unknown",
        "Rejected launch was reported as running",
      );
      assert.equal(
        (await call<D.ExecutionObservation>({ kind: "start-execution", input: prepared })).state,
        "unknown",
        "Rejected launch was dispatched again",
      );
      const described = await call<{ status: 200; body: D.WorkspaceBinding }>({
        kind: "describe",
        input: { operationId: "describeWorkspace", path: { workspaceId: "workspace" }, query: {} },
      });
      assert.equal(described.body.revision, seeded.value.revision);
      return;
    }
    let observation: D.ExecutionObservation | undefined;
    for (let attempt = 0; attempt < 750; attempt++) {
      observation = await call({ kind: "query-execution", input: identity });
      if (observation?.state === "terminal") break;
      await delay(20);
    }
    assert.equal(observation?.state, "terminal");
    const result = await call<D.PreparedResult>({ kind: "collect-execution", input: identity });
    assert.equal(result.state, "succeeded");
    assert.ok(result.output.artifacts.length > 0);
    const artifact = await server.fetch(result.output.artifacts[0]?.endpoint ?? "");
    assert.equal(artifact.status, 200);
    assert.equal(await artifact.text(), `${"x".repeat(40000)}\n`);

    assert.ok(result.uploadId && result.commitId);
    const validation = await call<{ status: 200; body: D.UploadValidation }>({
      kind: "validate",
      input: {
        operationId: "validateUpload",
        path: { workspaceId: "workspace", uploadId: result.uploadId },
        query: {},
      },
    });
    const receipt = await call<{ status: 200; body: D.CommitReceipt }>({
      kind: "commit",
      input: {
        operationId: "commitUpload",
        path: { workspaceId: "workspace", uploadId: result.uploadId },
        query: {},
        body: {
          requestId: "cloud-commit-request",
          stageId: validation.body.stageId,
          commitId: result.commitId,
          uploadId: result.uploadId,
          operationId: lease.operationId,
          jobId: identity.jobId,
          workspaceId: "workspace",
          lease,
          manifestHash: result.manifestHash,
          baseRevision: lease.baseRevision,
        },
      },
    });
    const response = await server.fetch(
      `/read?revision=${receipt.body.revision}&path=run-count.txt`,
    );
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "1", "Duplicate dispatch reran user code");
    assert.equal(
      await (
        await server.fetch(`/read?revision=${receipt.body.revision}&path=confinement.txt`)
      ).text(),
      "4",
    );
    assert.deepEqual(
      await call({ kind: "collect-execution", input: identity }),
      result,
      "Collection retried a new stage",
    );
  } finally {
    await server.close();
  }
}
test(
  "actual cloud-JS authority ledger starts once, enforces rooted/no-egress access and publishes verified bytes",
  { timeout: 60_000 },
  () => runFixture(),
);
test(
  "unavailable host modules leave dispatch uncertain without a replacement start or publication",
  { timeout: 15_000 },
  () =>
    runFixture(
      "import value from 'fortipi-host-secret'; export default async function(){ return value; }",
      true,
    ),
);
