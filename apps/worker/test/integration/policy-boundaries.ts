import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { manifestDigest } from "fortipi-contract";
import { RoleContext } from "../../../../tests/clients/roles.ts";
import type * as D from "../../src/boundary/dto.js";
import { start } from "./runtime.ts";
import { readWorkspace, stageWorkspace } from "./workspace-portability.ts";

const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
/** Independent public byte/count boundaries, using declared lower allocations.
 * Actual platform/account exhaustion is deliberately a separate live claim. */
export async function workspacePolicyBoundaries() {
  const expected = { fileBytes: 8192, snapshotBytes: 16384, manifestEntries: 3 };
  const runtime = await start({ testBounds: expected }),
    roles = new RoleContext(runtime.endpoint, runtime.admin);
  const checked: {
    resource: string;
    below: number;
    at: number;
    above: number;
    rejectedStatus: number;
  }[] = [];
  try {
    const protocol = await runtime.api<D.Protocol>("/v1/protocol");
    assert.equal(protocol.status, 200);
    for (const [name, value] of Object.entries(expected))
      assert.equal(protocol.body.infrastructure.bounds[name as keyof typeof expected], value);
    for (const resource of ["file", "snapshot", "entries"] as const) {
      let binding = await roles.call({
        operationId: "createWorkspace",
        path: {},
        query: {},
        body: { requestId: randomUUID(), config: { kind: "computer" } },
      });
      const client = await roles.issue({
        requestId: randomUUID(),
        role: "client",
        grants: [
          {
            grantId: randomUUID(),
            version: 1,
            resources: {
              agentIds: [],
              conversationIds: [],
              workspaceIds: [binding.workspaceId],
              executorIds: [],
              backendIds: [],
              tools: [],
              actions: ["workspace.read", "workspace.write"],
            },
          },
        ],
      });
      const filesFor = (value: number): Record<string, Uint8Array> =>
        resource === "file"
          ? { "notes.txt": Buffer.from("x"), "edge.bin": Buffer.alloc(value, 101) }
          : resource === "snapshot"
            ? {
                "notes.txt": Buffer.from("x"),
                "edge.bin": Buffer.alloc(8192, 102),
                "tail.bin": Buffer.alloc(value - 8193, 103),
              }
            : Object.fromEntries(
                Array.from({ length: value }, (_, index) => [
                  `file-${index}`,
                  Buffer.from([index + 1]),
                ]),
              );
      const limit =
        resource === "file"
          ? expected.fileBytes
          : resource === "snapshot"
            ? expected.snapshotBytes
            : expected.manifestEntries;
      let retained: Record<string, Uint8Array> = {};
      for (const size of [limit - 1, limit]) {
        const files = filesFor(size),
          stage = await stageWorkspace(runtime, binding, client.token, files);
        const receipt = await stage.commit();
        assert.equal(receipt.status, 200);
        await stage.release();
        binding = {
          ...binding,
          revision: receipt.body.revision,
          manifestHash: receipt.body.manifestHash,
        };
        retained = files;
        await readWorkspace(runtime, binding, client.token, files);
      }
      const files = filesFor(limit + 1),
        manifest: D.Manifest = {
          version: 1,
          entries: Object.entries(files)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([path, bytes]) => ({
              path,
              type: "file",
              mode: 420,
              size: bytes.length,
              sha256: hash(bytes),
            })),
        };
      const operationId = randomUUID();
      const lease = await runtime.api<D.WorkspaceOperationLease>(
        `/v1/workspaces/${binding.workspaceId}/leases`,
        {
          requestId: randomUUID(),
          operationId,
          bindingVersion: binding.bindingVersion,
          baseRevision: binding.revision,
          deadline: Date.now() + 60000,
        },
        "POST",
        client.token,
      );
      assert.equal(lease.status, 201);
      const input: D.UploadBegin = {
        requestId: randomUUID(),
        operationId,
        commitId: randomUUID(),
        lease: lease.body,
        baseRevision: binding.revision,
        manifest,
        manifestHash: await manifestDigest(manifest),
        mutations: manifest.entries.map((entry) => {
          assert.equal(entry.type, "file");
          if (entry.type !== "file") assert.fail("File fixture");
          return {
            kind: "put",
            path: entry.path,
            mode: entry.mode,
            size: entry.size,
            sha256: entry.sha256,
          };
        }),
      };
      const rejected = await runtime.api<D.ErrorBody>(
        `/v1/workspaces/${binding.workspaceId}/uploads`,
        input,
        "POST",
        client.token,
      );
      // This body is inside the wire ceiling but exceeds the declared lower
      // allocation. The public contract distinguishes quota429 from wire413.
      assert.equal(rejected.status, 429);
      assert.equal(rejected.body.error.code, "quota_exceeded");
      assert.equal(
        (
          await roles.call({
            operationId: "describeWorkspace",
            path: { workspaceId: binding.workspaceId },
            query: {},
            body: undefined,
          })
        ).revision,
        binding.revision,
      );
      await readWorkspace(runtime, binding, client.token, retained);
      const release: D.WorkspaceLeaseRelease = {
        requestId: randomUUID(),
        lease: lease.body,
        reason: "cancelled",
      };
      assert.equal(
        (
          await runtime.api(
            `/v1/workspaces/${binding.workspaceId}/leases/${lease.body.leaseId}/release`,
            release,
            "POST",
            client.token,
          )
        ).status,
        200,
      );
      checked.push({
        resource,
        below: limit - 1,
        at: limit,
        above: limit + 1,
        rejectedStatus: rejected.status,
      });
    }
    return {
      actualPublicComputerByteBoundaries: checked,
      discoveredConfiguredBounds: expected,
      oldPublishedBytesAndRevisionsPreservedOnRefusal: true,
      schemaSha256: hash(
        await readFile(
          resolve(
            import.meta.dirname,
            "../../../../packages/fortipi-contract/schemas/common.schema.json",
          ),
        ),
      ),
      limitations: [
        "Explicit lower schema-valid allocation limits; no actual Free account ceiling or platform exhaustion proof",
        "Concurrent admission, retained-event bounds, physical reclamation and native output budgets are companion observations",
      ],
    };
  } finally {
    const cleanup = await roles.cleanup();
    await runtime.dispose();
    assert.ok(cleanup.every((row) => row.state === "complete"));
  }
}
