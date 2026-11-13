import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import {
  canonicalJson,
  type Manifest,
  type Mutation,
  type WorkspaceOperationLease,
} from "../../packages/fortipi-contract/dist/index.js";
import type { Installed } from "../distribution/install.ts";
import type { ScenarioEvidence } from "./evidence.ts";
import type { RecoveryWorkspaceCanary } from "./platform-recovery.ts";
import type { RoleContext } from "./roles.ts";

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
/** A metadata-only refusal companion, not an exhaustion/load generator. No
 * model, executor, policy mutation or upload chunk is invoked. Below/at-limit,
 * storage/SQL/CPU/account headroom remain independent required observations. */
export async function runLiveAllocationRefusals(input: {
  installed: Pick<Installed, "candidate" | "resolveExport">;
  roles: RoleContext;
  workspace: RecoveryWorkspaceCanary;
}): Promise<ScenarioEvidence> {
  const { installed, roles, workspace } = input;
  assert.equal(workspace.binding.config.kind, "computer");
  assert.ok(workspace.files.length > 0 && workspace.files.length <= 3);
  const module = (await import(
    pathToFileURL(installed.resolveExport(`@${installed.candidate.scope}/fortipi-client/node`)).href
  )) as typeof import("../../packages/fortipi-client/dist/node.js");
  const issued = await roles.issue({
    requestId: randomUUID(),
    role: "client",
    expiresAt: Date.now() + 12 * 60000,
    grants: [
      {
        grantId: randomUUID(),
        version: 1,
        resources: {
          agentIds: [],
          conversationIds: [],
          executorIds: [],
          backendIds: [],
          tools: [],
          workspaceIds: [workspace.binding.workspaceId],
          actions: ["workspace.read", "workspaces.read", "workspace.write"],
        },
      },
    ],
  });
  const client = new module.FortiPiClient({
    endpoint: roles.endpoint,
    credentials: async () => issued.token,
    allowLoopbackHttp: new URL(roles.endpoint).protocol === "http:",
  });
  const deadline = Date.now() + 10 * 60000;
  const signal = AbortSignal.timeout(10 * 60000);
  const retryDelays: number[] = [];
  async function call<T>(operation: () => Promise<T>): Promise<T> {
    for (;;) {
      try {
        return await operation();
      } catch (error) {
        if (
          !(error instanceof module.FortiPiError) ||
          error.status !== 429 ||
          error.code !== "rate_limited" ||
          !error.retryable
        )
          throw error;
        const wait = error.retryAfterMs ?? error.details?.retryAfterMs;
        assert.ok(
          Number.isSafeInteger(wait) &&
            wait &&
            wait > 0 &&
            wait <= 60000 &&
            retryDelays.length < 8 &&
            Date.now() + wait < deadline,
          "Explicit bounded request retry guidance is required",
        );
        // A rate wait cannot silently replace/renew the original operation.
        // If this lease cannot survive, reject this run and retain uncertainty.
        assert.ok(
          !lease || lease.expiresAt > Date.now() + wait + 5000,
          "Lease cannot survive the declared rate wait",
        );
        retryDelays.push(wait);
        await delay(wait, undefined, { signal });
      }
    }
  }
  let lease: WorkspaceOperationLease | undefined;
  const observations: {
    resource: string;
    limit: number;
    declared: number;
    status: number;
    code: string;
  }[] = [];
  const cleanup: { leaseId: string; released: boolean }[] = [];
  let revoked = false;
  async function unchanged() {
    assert.deepEqual(
      await call(() => client.workspaces.get(workspace.binding.workspaceId, { signal })),
      workspace.binding,
    );
    for (const expected of workspace.files) {
      const bytes = await call(() =>
        client.workspaces.read(
          workspace.binding.workspaceId,
          { revision: workspace.binding.revision, path: expected.path },
          { signal },
        ),
      );
      assert.deepEqual({ path: expected.path, size: bytes.length, sha256: hash(bytes) }, expected);
    }
  }
  async function release() {
    if (!lease) return;
    const current = lease;
    const releaseBody = { requestId: randomUUID(), lease: current, reason: "cancelled" as const };
    const receipt = await call(() =>
      client.operations.releaseWorkspaceLease(
        {
          path: { workspaceId: current.workspaceId, leaseId: current.leaseId },
          query: {},
          body: releaseBody,
        },
        { signal },
      ),
    );
    assert.equal(receipt.leaseId, current.leaseId);
    assert.equal(receipt.released, true);
    cleanup.push({ leaseId: receipt.leaseId, released: receipt.released });
    lease = undefined;
  }
  try {
    const protocol = await call(() => client.negotiate(signal));
    const limits = { file: 4 * 1024 * 1024, snapshot: 16 * 1024 * 1024, entries: 512 };
    // Independent frozen Foundation defaults, not values derived from the
    // implementation's comparator. A different operator policy needs its own
    // reviewed allocation oracle; this port never rewrites that policy.
    assert.equal(protocol.infrastructure.bounds.fileBytes, limits.file);
    assert.equal(protocol.infrastructure.bounds.snapshotBytes, limits.snapshot);
    assert.equal(protocol.infrastructure.bounds.manifestEntries, limits.entries);
    await unchanged();
    for (const resource of ["file", "snapshot", "entries"] as const) {
      // Let the documented request-minute window elapse BEFORE acquiring the
      // short workspace lease. Never sleep a lease through a rate refusal or
      // replace its operation ID to make an expired operation appear valid.
      await delay(60000, undefined, { signal });
      const sizes =
        resource === "file"
          ? [limits.file + 1]
          : resource === "snapshot"
            ? [limits.file, limits.file, limits.file, limits.file, 1]
            : Array<number>(limits.entries + 1).fill(1);
      const manifest: Manifest = {
        version: 1,
        entries: sizes.map((size, i) => ({
          path: `edge-${String(i).padStart(4, "0")}.bin`,
          type: "file",
          mode: 420,
          size,
          sha256: hash(Buffer.alloc(size, 101)),
        })),
      };
      const operationId = randomUUID();
      const acquireBody = {
        requestId: randomUUID(),
        operationId,
        bindingVersion: workspace.binding.bindingVersion,
        baseRevision: workspace.binding.revision,
        deadline: Date.now() + 120000,
      };
      lease = await call(() =>
        client.operations.acquireWorkspaceLease(
          {
            path: { workspaceId: workspace.binding.workspaceId },
            query: {},
            body: acquireBody,
          },
          { signal },
        ),
      );
      const mutations: Mutation[] = [
        ...workspace.files.map((file) => ({ kind: "delete" as const, path: file.path })),
        ...manifest.entries.map((entry) => {
          assert.equal(entry.type, "file");
          if (entry.type !== "file") throw new Error("File allocation fixture required");
          return {
            kind: "put" as const,
            path: entry.path,
            mode: entry.mode,
            size: entry.size,
            sha256: entry.sha256,
          };
        }),
      ];
      const body = {
        requestId: randomUUID(),
        operationId,
        commitId: randomUUID(),
        baseRevision: workspace.binding.revision,
        lease,
        manifest,
        manifestHash: hash(`fortipi:manifest:v1\n${canonicalJson(manifest)}`),
        mutations,
      };
      try {
        let admitted: Awaited<ReturnType<typeof client.uploads.begin>> | undefined;
        let failure: unknown;
        try {
          admitted = await call(() =>
            client.uploads.begin(workspace.binding.workspaceId, body, { signal }),
          );
        } catch (error) {
          failure = error;
        }
        // An earned admission is never called a passing refusal. Abort the real
        // allocated stage before propagating failure; an abort error is never
        // reclassified as the begin operation's expected quota refusal.
        if (admitted !== undefined) {
          try {
            await client.uploads.abort(workspace.binding.workspaceId, admitted.uploadId, {
              signal,
            });
          } catch {
            throw new Error("Above-allocation upload was admitted; stage abort outcome unknown");
          }
          throw new Error("Above-allocation upload was admitted");
        }
        if (!(failure instanceof module.FortiPiError)) throw failure;
        assert.equal(failure.status, 429);
        assert.equal(failure.code, "quota_exceeded");
        observations.push({
          resource,
          limit: limits[resource],
          declared:
            resource === "file"
              ? sizes[0]!
              : resource === "snapshot"
                ? sizes.reduce((a, b) => a + b, 0)
                : sizes.length,
          status: failure.status,
          code: failure.code,
        });
      } finally {
        await release();
      }
      await unchanged();
    }
    const receipt = await roles.revokeAndWait(issued.credential.credentialId);
    assert.equal(receipt.state, "complete");
    assert.equal(receipt.pendingRecipients.length, 0);
    revoked = true;
    const result: ScenarioEvidence = {
      observation: {
        workspaceId: workspace.binding.workspaceId,
        originalRevision: workspace.binding.revision,
        originalManifestHash: workspace.binding.manifestHash,
        canonicalFiles: workspace.files,
        refusals: observations,
        cleanup,
        revoked: true,
        uploadedChunks: 0,
        retryDelays,
        requestWindowWaitBeforeEachLeaseMs: 60000,
      },
      oracle:
        "Actual public begin-upload refuses individually above-default file/snapshot/manifest allocations as quota429 before chunk delivery; each lease releases and the original published binding and independently hashed nonempty bytes remain intact",
      sensitivity: [
        "Wrong error class, an admitted stage, changed old byte/hash/revision or unavailable lease/role cleanup blocks this companion",
      ],
      limitations: [
        "Above-allocation metadata refusals only: no below/at transfer qualification, actual platform/account exhaustion, SQL/CPU/memory/store-reclamation or shared-headroom inference",
        "A whole infrastructure-boundaries claim still needs all other approved component and real target observations",
      ],
    };
    roles.assertSanitized(result);
    return result;
  } finally {
    try {
      await release();
    } finally {
      if (!revoked) {
        const receipt = await roles.revokeAndWait(issued.credential.credentialId);
        assert.equal(receipt.state, "complete");
      }
    }
  }
}
