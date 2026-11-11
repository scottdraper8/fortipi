import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { manifestDigest } from "fortipi-contract";
import { createTestHarness } from "wrangler";
import type * as D from "../../src/boundary/dto.js";
import { harness, root, workspaceConfig } from "./harness.ts";
import { RecoveryProcess } from "./recovery-process.ts";
import { workspaceTarget } from "./target.ts";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const logical = { "x-test-export-action": "backups.create" };
const resources: D.ResourceScope = {
  agentIds: ["agent"],
  conversationIds: ["conversation"],
  workspaceIds: ["workspace"],
  actions: [],
  tools: [],
  executorIds: [],
  backendIds: [],
};
type Rpc = <T>(body: unknown, headers?: Record<string, string>) => Promise<D.Outcome<T>>;
async function json<T>(response: { json(): Promise<unknown> }): Promise<T> {
  return (await response.json()) as T;
}
function value<T>(result: D.Outcome<T>): T {
  if (!result.ok) assert.fail(JSON.stringify(result));
  return result.value;
}
function exported(result: D.Outcome<D.ExportDescriptor>): D.AdminArtifactReference[] {
  const descriptor = value(result);
  assert.equal(descriptor.state, "ready", "Logical export did not retain a complete snapshot");
  return descriptor.artifacts.map((reference) => {
    assert.ok("scope" in reference);
    return reference;
  });
}
function request(exportId: string, overrides: Partial<D.ExportRequest> = {}): D.ExportRequest {
  return {
    exportId,
    action: "backups.create",
    resources,
    maxBytes: 16_777_216,
    deadline: Date.now() + 30_000,
    ...overrides,
  };
}
async function publish(
  rpc: Rpc,
  baseRevision: string,
  name: string,
  bytes: Uint8Array,
): Promise<D.CommitReceipt> {
  const lease = value(
    await rpc<D.Lease>({ kind: "acquire", input: await workspaceTarget(name, baseRevision) }),
  );
  const manifest: D.Manifest = {
    version: 1,
    entries: [
      { path: "canary.bin", type: "file", mode: 420, size: bytes.length, sha256: sha(bytes) },
      { path: "empty", type: "file", mode: 420, size: 0, sha256: sha(new Uint8Array()) },
      { path: "directory", type: "directory", mode: 493 },
    ],
  };
  const hash = await manifestDigest(manifest);
  const begun = value(
    await rpc<{ status: 201; body: D.UploadStatus }>({
      kind: "begin",
      input: {
        operationId: "beginUpload",
        path: { workspaceId: "workspace" },
        query: {},
        body: {
          requestId: name,
          baseRevision,
          lease,
          operationId: lease.operationId,
          commitId: `commit-${name}`,
          manifest,
          manifestHash: hash,
          mutations: manifest.entries.map((entry) =>
            entry.type === "file"
              ? {
                  kind: "put",
                  path: entry.path,
                  mode: entry.mode,
                  size: entry.size,
                  sha256: entry.sha256,
                }
              : { kind: "mkdir", path: entry.path },
          ),
        },
      },
    }),
  );
  for (const file of [bytes, new Uint8Array()]) {
    for (let offset = 0, index = 0; offset < file.length; offset += 262144, index++) {
      const chunk = file.slice(offset, offset + 262144);
      value(
        await rpc({
          kind: "chunk",
          input: {
            operationId: "putUploadChunk",
            path: {
              workspaceId: "workspace",
              uploadId: begun.body.uploadId,
              sha256: sha(file),
              chunkIndex: index,
            },
            query: { length: chunk.length, sha256: sha(chunk) },
          },
          bytes: [...chunk],
        }),
      );
    }
  }
  const validated = value(
    await rpc<{ status: 200; body: D.UploadValidation }>({
      kind: "validate",
      input: {
        operationId: "validateUpload",
        path: { workspaceId: "workspace", uploadId: begun.body.uploadId },
        query: {},
      },
    }),
  );
  const receipt = value(
    await rpc<{ status: 200; body: D.CommitReceipt }>({
      kind: "commit",
      input: {
        operationId: "commitUpload",
        path: { workspaceId: "workspace", uploadId: begun.body.uploadId },
        query: {},
        body: {
          requestId: `commit-${name}`,
          stageId: validated.body.stageId,
          commitId: `commit-${name}`,
          uploadId: begun.body.uploadId,
          operationId: lease.operationId,
          workspaceId: "workspace",
          lease,
          manifestHash: hash,
          baseRevision,
        },
      },
    }),
  ).body;
  value(await rpc({ kind: "release", input: { requestId: `release-${name}`, lease } }));
  return receipt;
}

test("logical workspace exports retain an immutable manifest and verified peer parts without public read", {
  timeout: 120_000,
}, async () => {
  const server = harness();
  const rpc: Rpc = async (body, headers = {}) =>
    json(await server.fetch("/rpc", { method: "POST", headers, body: JSON.stringify(body) }));
  try {
    await server.listen();
    const binding = value(await json<D.Outcome<D.WorkspaceBinding>>(await server.fetch("/seed")));
    const empty = exported(await rpc({ kind: "export", input: request("empty-cloud") }, logical));
    assert.equal(empty.length, 1);
    const emptyIndex = await json<{ manifest: D.Manifest }>(
      await server.fetch(empty[0]?.endpoint ?? "", { headers: logical }),
    );
    assert.deepEqual(emptyIndex.manifest, { version: 1, entries: [] });
    const bytes = Uint8Array.from({ length: 1_100_013 }, (_, index) => index % 251);
    const receipt = await publish(rpc, binding.revision, "export-source", bytes);
    const input = request("snapshot");
    const refs = exported(await rpc({ kind: "export", input }, logical));
    assert.equal(refs.length, 4);
    const payloads = new Map<string, Uint8Array>();
    for (const reference of refs) {
      assert.deepEqual(reference.scope, {
        kind: "workspace",
        workspaceId: "workspace",
        revision: receipt.revision,
      });
      assert.equal("workspaceId" in reference, false);
      const response = await server.fetch(reference.endpoint, { headers: logical });
      assert.equal(response.status, 200);
      assert.equal(
        response.headers.get("Content-Length"),
        String(reference.size),
        "Export peer lost known Content-Length",
      );
      assert.equal(response.headers.get("Cache-Control"), "no-store");
      const body = new Uint8Array(await response.arrayBuffer());
      assert.equal(body.length, reference.size);
      assert.equal(sha(body), reference.sha256);
      payloads.set(reference.artifactId, body);
    }
    const index = JSON.parse(new TextDecoder().decode(payloads.get(refs[0]?.artifactId ?? ""))) as {
      version: 1;
      workspaceId: string;
      revision: string;
      manifestHash: string;
      manifest: D.Manifest;
      files: {
        path: string;
        parts: { artifactId: string; offset: number; size: number; sha256: string }[];
      }[];
    };
    assert.equal(index.manifestHash, receipt.manifestHash);
    assert.equal(await manifestDigest(index.manifest), receipt.manifestHash);
    assert.deepEqual(Object.keys(index).sort(), [
      "files",
      "manifest",
      "manifestHash",
      "revision",
      "version",
      "workspaceId",
    ]);
    const actual = new Uint8Array(bytes.length);
    for (const file of index.files)
      for (const part of file.parts) {
        const body = payloads.get(part.artifactId);
        assert.ok(body);
        assert.equal(body.length, part.size);
        assert.equal(sha(body), part.sha256);
        if (file.path === "canary.bin") actual.set(body, part.offset);
        else assert.equal(body.length, 0);
      }
    assert.equal(
      sha(actual),
      sha(bytes),
      "Export copied a different source than its retained manifest",
    );
    const raw = refs[1];
    assert.ok(raw);
    const range = await server.fetch(raw.endpoint, {
      headers: { ...logical, Range: "bytes=37-600036" },
    });
    assert.equal(range.status, 206);
    assert.equal(range.headers.get("Content-Length"), "600000");
    const ranged = new Uint8Array(await range.arrayBuffer());
    assert.equal(sha(ranged), sha(bytes.slice(37, 600037)));
    assert.equal(range.headers.get("X-Content-SHA256"), sha(ranged));
    const invalid = await server.fetch(raw.endpoint, {
      headers: { ...logical, Range: "bytes=0-0,2-2" },
    });
    assert.equal(invalid.status, 416);
    for (const headers of [
      {},
      { "x-test-export-action": "exports.create" },
      { ...logical, "x-test-unregistered": "1" },
      { ...logical, "x-test-expired": "1" },
      { ...logical, "x-test-other-agent": "1" },
      { ...logical, "x-test-other-conversation": "1" },
      { ...logical, "x-test-split-scope": "1" },
    ]) {
      const denied = await server.fetch(raw.endpoint, { headers });
      assert.ok(
        denied.status === 401 || denied.status === 403,
        "Unscoped or split grant read retained export bytes",
      );
    }
    assert.equal(
      (
        await server.fetch(raw.endpoint, {
          headers: {
            ...logical,
            "x-test-no-context": "1",
            "x-fortipi-workspace-context": JSON.stringify({ auth: { grants: ["*"] } }),
          },
        })
      ).status,
      403,
    );
    assert.equal(
      (await server.fetch(`${raw.endpoint}?revision=${receipt.revision}`, { headers: logical }))
        .status,
      400,
    );
    assert.equal(
      (await server.fetch(raw.endpoint, { method: "POST", headers: logical })).status,
      400,
    );
    for (const operation of ["describe", "manifest", "read-metadata", "public-receipt"] as const) {
      const operationId = {
        describe: "describeWorkspace",
        manifest: "getWorkspaceManifest",
        "read-metadata": "readWorkspaceFile",
        "public-receipt": "getCommitReceipt",
      }[operation];
      const denied = await rpc(
        {
          kind: operation,
          input: {
            operationId,
            path: { workspaceId: "workspace", commitId: receipt.commitId },
            query: { revision: receipt.revision, path: "canary.bin" },
          },
        },
        logical,
      );
      assert.equal(denied.ok, false, "Logical export grant widened a public read guard");
    }
    assert.equal(
      (
        await server.fetch(`/read?revision=${receipt.revision}&path=canary.bin`, {
          headers: logical,
        })
      ).status,
      403,
    );
    const wrong = await rpc(
      {
        kind: "export",
        input: request("wrong-scope", { resources: { ...resources, agentIds: ["other"] } }),
      },
      logical,
    );
    assert.equal(
      wrong.ok,
      false,
      "Logical export accepted requested resources outside its one current grant",
    );
    const split = await rpc(
      { kind: "export", input: request("split") },
      { ...logical, "x-test-split-scope": "1" },
    );
    assert.equal(split.ok, false);
    const changed = await rpc(
      { kind: "export", input: { ...input, maxBytes: input.maxBytes - 1 } },
      logical,
    );
    assert.equal(changed.ok, false);
    const partial = value(
      await rpc<D.ExportDescriptor>(
        { kind: "export", input: request("too-small", { maxBytes: 1 }) },
        logical,
      ),
    );
    assert.equal(partial.state, "partial");
    assert.deepEqual(partial.artifacts, []);
    const next = await publish(
      rpc,
      receipt.revision,
      "new-live-root",
      new TextEncoder().encode("new current bytes"),
    );
    assert.notEqual(next.revision, receipt.revision);
    assert.deepEqual(
      exported(
        await rpc({ kind: "export", input: { ...input, deadline: Date.now() + 30_000 } }, logical),
      ),
      refs,
      "Retry selected a newer live source cut",
    );
    assert.equal(
      sha(
        new Uint8Array(
          await (await server.fetch(raw.endpoint, { headers: logical })).arrayBuffer(),
        ),
      ),
      raw.sha256,
    );
    for (let attempt = 0; attempt < 5; attempt++) {
      const cancelled: { cancelled: boolean } = await json(
        await server.fetch(`/export-stream-control?artifactId=${raw.artifactId}&mode=cancel`, {
          headers: logical,
        }),
      );
      assert.equal(cancelled.cancelled, true);
    }
    for (const mode of ["abort", "deadline", "revoke"]) {
      const result: { first: number; rejected: boolean } = await json(
        await server.fetch(`/export-stream-control?artifactId=${raw.artifactId}&mode=${mode}`, {
          headers: { ...logical, ...(mode === "deadline" ? { "x-test-short-deadline": "1" } : {}) },
        }),
      );
      assert.ok(result.first > 0);
      assert.equal(result.rejected, true, `Export peer did not stop on ${mode}`);
    }
    assert.equal(
      (await server.fetch(raw.endpoint, { headers: logical })).status,
      403,
      "Revoked reader reopened export bytes",
    );
  } finally {
    await server.close();
  }
});

test("workspace export copy rejects actual corrupt, truncated and newly revoked source streams", {
  timeout: 120_000,
}, async () => {
  const server = harness();
  const rpc: Rpc = async (body, headers = {}) =>
    json(await server.fetch("/rpc", { method: "POST", headers, body: JSON.stringify(body) }));
  try {
    await server.listen();
    const binding = value(await json<D.Outcome<D.WorkspaceBinding>>(await server.fetch("/seed")));
    const bytes = Uint8Array.from({ length: 180013 }, (_, i) => i % 193);
    await publish(rpc, binding.revision, "fault-source", bytes);
    const storage = await server
      .getWorker()
      .getDurableObjectStorage("WORKSPACES", { name: "workspace" });
    for (const mode of ["corrupt", "truncate", "revoke"]) {
      const id = `source-${mode}`;
      const result = await rpc(
        { kind: "export", input: request(id) },
        { ...logical, "x-test-request-id": `export-${mode}` },
      );
      assert.equal(result.ok, false, `Export accepted ${mode} source bytes`);
      const chunks = await storage.exec(
        "SELECT count(*) AS n FROM fp_ws_export_chunk WHERE export_id=?",
        id,
      );
      assert.equal(chunks[0]?.n, 0);
      const ready = await storage.exec(
        "SELECT key FROM fp_ws_record WHERE key LIKE 'export-artifact:%'",
      );
      assert.equal(ready.length, 0, "Incomplete export published artifact references");
    }
    const repaired = exported(
      await rpc(
        { kind: "export", input: request("source-corrupt") },
        { ...logical, "x-test-recovery": "1" },
      ),
    );
    assert.equal(repaired[1]?.sha256, sha(bytes));
  } finally {
    await server.close();
  }
});

test("retained workspace export survives actual SIGKILL after copy before reply and never recuts on retry", {
  timeout: 120_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "fortipi-export-recovery-"));
  const runtime = new RecoveryProcess(directory);
  const rpc: Rpc = async (body, headers = {}) =>
    (
      await fetch(`${runtime.url}/rpc`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      })
    ).json();
  try {
    await runtime.start();
    const binding = value(
      (await (await fetch(`${runtime.url}/seed`)).json()) as D.Outcome<D.WorkspaceBinding>,
    );
    const bytes = new TextEncoder().encode("durable original export member");
    const receipt = await publish(rpc, binding.revision, "durable-export-source", bytes);
    const input = request("kill-export-reply");
    let settled = false;
    const pending = rpc<D.ExportDescriptor>({ kind: "export", input }, logical).then(
      () => {
        settled = true;
      },
      () => {},
    );
    const deadline = Date.now() + 10_000;
    while (
      Date.now() < deadline &&
      (await (await fetch(`${runtime.url}/barrier`)).text()) !== "ready"
    )
      await delay(20);
    assert.equal(await (await fetch(`${runtime.url}/barrier`)).text(), "ready");
    assert.equal(settled, false);
    await runtime.kill();
    await pending;
    await runtime.start();
    const refs = exported(await rpc({ kind: "export", input }, logical));
    await publish(
      rpc,
      receipt.revision,
      "after-export-reopen",
      new TextEncoder().encode("replacement bytes"),
    );
    assert.deepEqual(
      exported(
        await rpc({ kind: "export", input: { ...input, deadline: Date.now() + 30_000 } }, logical),
      ),
      refs,
    );
    const file = refs[1];
    assert.ok(file);
    const response = await fetch(`${runtime.url}${file.endpoint}`, { headers: logical });
    assert.equal(response.status, 200);
    assert.equal(sha(new Uint8Array(await response.arrayBuffer())), sha(bytes));
  } finally {
    await runtime.kill();
    await rm(directory, { recursive: true, force: true });
  }
});

test("local export without retained sealed bytes is explicitly unavailable", async () => {
  const server = createTestHarness({
    root,
    workers: [
      {
        config: {
          ...workspaceConfig(),
          main:
            process.env.FORTIPI_LOCAL_TEST_ENTRY ??
            resolve(root, "apps/worker/test/workspace/local-upload-worker.ts"),
        },
      },
    ],
  });
  try {
    await server.listen();
    const bound = await json<D.Outcome<D.WorkspaceBinding>>(
      await server.fetch("/rpc", {
        method: "POST",
        headers: { "x-test-bootstrap": "1" },
        body: JSON.stringify({
          kind: "binding",
          input: {
            requestId: "export-local",
            binding: {
              workspaceId: "workspace",
              bindingVersion: 1,
              config: { kind: "local", executorId: "executor", rootBindingId: "opaque-root" },
            },
            expectedVersion: null,
            executor: { executorId: "executor", generation: 1 },
            import: {
              revision: "local-base",
              manifest: { version: 1, entries: [] },
              acknowledgeExternalEffects: true,
            },
          },
        }),
      }),
    );
    value(bound);
    const descriptor = value(
      await json<D.Outcome<D.ExportDescriptor>>(
        await server.fetch("/rpc", {
          method: "POST",
          headers: logical,
          body: JSON.stringify({ kind: "export", input: request("local-export") }),
        }),
      ),
    );
    assert.equal(descriptor.state, "unavailable");
    assert.deepEqual(descriptor.artifacts, []);
    assert.deepEqual(descriptor.unavailableWorkspaceIds, ["workspace"]);
  } finally {
    await server.close();
  }
});

test("export retention expires in real time and physical SQLite headroom stops additional copies", {
  timeout: 30_000,
}, async () => {
  const config = workspaceConfig();
  const server = createTestHarness({
    root,
    workers: [
      {
        config: {
          ...config,
          vars: {
            FORTIPI_CONFIG: {
              version: 1,
              infrastructure: {
                ...config.vars.FORTIPI_CONFIG.infrastructure,
                bounds: {
                  ...config.vars.FORTIPI_CONFIG.infrastructure.bounds,
                  objectBytes: 1_048_576,
                },
              },
            },
          },
        },
      },
    ],
  });
  const rpc: Rpc = async (body, headers = {}) =>
    json(await server.fetch("/rpc", { method: "POST", headers, body: JSON.stringify(body) }));
  try {
    await server.listen();
    const binding = value(await json<D.Outcome<D.WorkspaceBinding>>(await server.fetch("/seed")));
    const storage = await server
      .getWorker()
      .getDurableObjectStorage("WORKSPACES", { name: "workspace" });
    const first = await publish(
      rpc,
      binding.revision,
      "expiry-source",
      new TextEncoder().encode("retained before expiry"),
    );
    const input = request("expiring", { deadline: Date.now() + 1000 });
    const refs = exported(await rpc({ kind: "export", input }, logical));
    assert.equal(refs.length, 3);
    const captured = await storage.exec(
      "SELECT value FROM fp_ws_record WHERE key='export:expiring'",
    );
    const original = JSON.parse(String(captured[0]?.value)) as {
      intent: string;
      principalId: string;
      workspaceId: string;
      expiresAt: number;
      indexId: string;
      request: D.ExportRequest;
    };
    await delay(1200);
    assert.ok(
      [403, 404].includes(
        (await server.fetch(refs[0]?.endpoint ?? "", { headers: logical })).status,
      ),
    );
    assert.equal(
      (await rpc({ kind: "export", input: { ...input, deadline: Date.now() + 30_000 } }, logical))
        .ok,
      false,
      "Expired export ID was recycled into a fresh cut",
    );
    const cleanupDeadline = Date.now() + 3000;
    while (Date.now() < cleanupDeadline) {
      const rows = await storage.exec(
        "SELECT count(*) AS n FROM fp_ws_export_chunk WHERE export_id='expiring'",
      );
      if (rows[0]?.n === 0) break;
      await delay(25);
    }
    assert.equal(
      (
        await storage.exec(
          "SELECT count(*) AS n FROM fp_ws_export_chunk WHERE export_id='expiring'",
        )
      )[0]?.n,
      0,
    );
    const expiredRows = await storage.exec(
      "SELECT value FROM fp_ws_record WHERE key='export:expiring'",
    );
    const expired = JSON.parse(String(expiredRows[0]?.value)) as {
      state: string;
      intent: string;
      principalId: string;
      workspaceId: string;
      expiresAt: number;
      indexId: string;
      request: D.ExportRequest;
      artifactIds: string[];
    };
    assert.equal(expired.state, "expired");
    assert.deepEqual(
      Object.keys(expired).sort(),
      [
        "artifactIds",
        "expiresAt",
        "indexId",
        "intent",
        "principalId",
        "request",
        "state",
        "workspaceId",
      ],
      "Expired export retained captured payload instead of a compact tombstone",
    );
    for (const key of [
      "intent",
      "principalId",
      "workspaceId",
      "expiresAt",
      "indexId",
      "request",
    ] as const)
      assert.deepEqual(expired[key], original[key]);
    assert.deepEqual(
      expired.artifactIds,
      refs.map((reference) => reference.artifactId),
    );
    assert.ok(String(expiredRows[0]?.value).length < String(captured[0]?.value).length);
    await publish(
      rpc,
      first.revision,
      "physical-source",
      Uint8Array.from({ length: 180013 }, (_, i) => i % 173),
    );
    assert.equal(
      (await rpc({ kind: "export", input: { ...input, deadline: Date.now() + 30_000 } }, logical))
        .ok,
      false,
      "Expired tombstone was promoted into a newer live snapshot",
    );
    assert.deepEqual(
      await storage.exec("SELECT value FROM fp_ws_record WHERE key='export:expiring'"),
      expiredRows,
    );
    await storage.exec(
      "INSERT INTO fp_ws_record(key,value) VALUES('test-physical-padding',?)",
      JSON.stringify("p".repeat(600000)),
    );
    const result = await rpc({ kind: "export", input: request("physical-copy") }, logical);
    assert.equal(result.ok, false, "Export ignored its physical object headroom");
    if (!result.ok) assert.equal(result.code, "quota_exceeded");
    assert.equal(
      (
        await storage.exec(
          "SELECT count(*) AS n FROM fp_ws_export_chunk WHERE export_id='physical-copy'",
        )
      )[0]?.n,
      0,
    );
    assert.equal(
      (await storage.exec("SELECT key FROM fp_ws_record WHERE key LIKE 'export-artifact:%'"))
        .length,
      0,
    );
    const physical = await json<{ bytes: number }>(await server.fetch("/export-physical"));
    assert.ok(
      physical.bytes <= 1_048_576 * 0.75,
      "Export crossed the configured physical SQLite ceiling",
    );
  } finally {
    await server.close();
  }
});
