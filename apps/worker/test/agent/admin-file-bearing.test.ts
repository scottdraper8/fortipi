import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import process from "node:process";
import test from "node:test";
import { manifestDigest } from "fortipi-contract";
import type * as D from "../../src/boundary/dto.js";
import { computerBase } from "../execution/computer-base.ts";
import type { ExportObservation, WorkspaceObject } from "./admin-file-bearing-worker.ts";
import { bootstrap, harness, pause, setup } from "./harness.ts";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const scope = (value: Partial<D.ResourceScope> = {}): D.ResourceScope => ({
  agentIds: [],
  conversationIds: [],
  workspaceIds: [],
  executorIds: [],
  backendIds: [],
  tools: [],
  actions: [],
  ...value,
});
type Harness = Awaited<ReturnType<typeof harness>>;
async function open() {
  const h = await harness({
    main:
      process.env.FORTIPI_ADMIN_FILE_BEARING_WORKER ??
      resolve("apps/worker/test/agent/admin-file-bearing-worker.ts"),
    traffic: "free",
  });
  const api = h.api;
  h.api = async <T>(
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
    token = bootstrap,
  ) => {
    const result = await api<T>(path, body, method, token);
    const error = (result.body as D.ErrorBody)?.error;
    if (result.status !== 429 || error?.code !== "rate_limited") return result;
    assert.equal(error.retryable, true);
    assert.ok(error.details?.retryAfterMs);
    // Honor actual transport pressure with the identical request and principal.
    // Never change policy limits or use another credential to evade the hold.
    await pause(error.details.retryAfterMs);
    return api<T>(path, body, method, token);
  };
  return h;
}

async function issue(h: Harness, resources: D.ResourceScope, executorId?: string) {
  const result = await h.api<D.CredentialReceipt>("/v1/admin/credentials", {
    requestId: crypto.randomUUID(),
    role: executorId ? "executor" : "admin",
    ...(executorId ? { executorId } : {}),
    grants: [{ grantId: crypto.randomUUID(), version: 1, resources }],
  });
  assert.equal(result.status, 201);
  if (result.body.state !== "issued") assert.fail("Real scoped synthetic credential required");
  return result.body.token;
}

// Public polling stays within the unchanged Free request limits (30/principal/minute).
async function observe<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 20; i++) {
    const value = await read();
    if (ready(value)) return value;
    await pause(1000);
  }
  assert.fail("Public operation did not reach its expected durable state");
}
async function append(h: Harness, cid: string, content: string, token = bootstrap) {
  const response = await h.api(
    `/v1/conversations/${cid}/messages`,
    {
      clientRequestId: crypto.randomUUID(),
      content,
      busyBehavior: "followUp",
    },
    "POST",
    token,
  );
  assert.equal(response.status, 202, JSON.stringify(response.body));
  return observe(
    async () => {
      const value = await h.api<D.ConversationProjection>(
        `/v1/conversations/${cid}`,
        undefined,
        "GET",
        token,
      );
      assert.equal(value.status, 200);
      return value.body;
    },
    (value) => value.messages.some((message) => message.content === `answer:${content}`),
  );
}
async function workspace(h: Harness, config: D.WorkspaceBinding["config"]) {
  const result = await h.api<D.WorkspaceBinding>("/v1/workspaces", {
    requestId: crypto.randomUUID(),
    config,
  });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body;
}
async function operation(h: Harness, resources: D.ResourceScope, maxBytes = 1048576) {
  const creator = await issue(h, { ...resources, actions: ["backups.create"] });
  const poller = await issue(h, { ...resources, actions: ["operations.read"] });
  const input: D.ExportInput = { requestId: crypto.randomUUID(), resources, maxBytes };
  const accepted = await h.api<D.AdminOperation>("/v1/admin/backups", input, "POST", creator);
  assert.equal(accepted.status, 202, JSON.stringify(accepted.body));
  const endpoint = `/v1/admin/operations/${accepted.body.operationId}`;
  const completed = await observe(
    async () => {
      const response = await h.api<D.AdminOperation>(endpoint, undefined, "GET", poller);
      assert.equal(response.status, 200, JSON.stringify(response.body));
      return response.body;
    },
    (value) => ["completed", "failed", "unavailable"].includes(value.state),
  );
  return { creator, input, completed, endpoint };
}
async function observation(h: Harness, workspaceId: string) {
  const env = await h.server
    .getWorker<{ WORKSPACES: DurableObjectNamespace<WorkspaceObject> }>()
    .getEnv();
  return JSON.parse(
    await env.WORKSPACES.getByName(workspaceId).exportObservationJson(),
  ) as ExportObservation;
}
async function download(h: Harness, reference: D.AdminArtifactReference, token: string) {
  const response = await h.server.fetch(`http://fortipi.local${reference.endpoint}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 200);
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.equal(bytes.length, reference.size);
  assert.equal(sha(bytes), reference.sha256);
  assert.equal(response.headers.get("Content-Length"), String(bytes.length));
  assert.equal(response.headers.get("X-Content-SHA256"), reference.sha256);
  return bytes;
}

test("public backup retains exact Pi transcript and committed Computer file bytes with scoped immutable downloads", {
  timeout: 180000,
}, async () => {
  const h = await open();
  try {
    const { agent, conversation } = await setup(h);
    const cid = conversation.conversationId;
    const actor = await issue(
      h,
      scope({
        agentIds: [agent.agentId],
        conversationIds: [cid],
        actions: ["messages.submit", "conversations.read"],
      }),
    );
    const before = await append(h, cid, "file-backup-before-cut", actor);
    const excluded = await h.api<D.Conversation>(`/v1/agents/${agent.agentId}/conversations`, {
      requestId: crypto.randomUUID(),
      title: "outside-export-scope",
    });
    assert.equal(excluded.status, 201);
    const empty = await workspace(h, { kind: "computer" });
    const writer = await issue(
      h,
      scope({
        workspaceIds: [empty.workspaceId],
        backendIds: [empty.workspaceId],
        actions: ["workspace.write", "workspace.read"],
      }),
    );
    const binding = await computerBase(h, empty, writer, 1);
    const unselected = await workspace(h, { kind: "computer" });
    const read = await h.server.fetch(
      `http://fortipi.local/v1/workspaces/${binding.workspaceId}/read?revision=${binding.revision}&path=file-000.txt`,
      { headers: { Authorization: `Bearer ${writer}` } },
    );
    assert.equal(read.status, 200);
    const canonical = new Uint8Array(await read.arrayBuffer());
    assert.deepEqual(canonical, new TextEncoder().encode("actual snapshot input\n"));
    const resources = scope({
      agentIds: [agent.agentId],
      conversationIds: [cid],
      workspaceIds: [binding.workspaceId],
    });
    const { creator, input, completed, endpoint } = await operation(h, resources);
    assert.equal(completed.kind, "backup");
    assert.equal(completed.state, "completed", JSON.stringify(completed));
    assert.equal(completed.artifacts.length, 3, "One Agent payload, Workspace index and real file");
    const reader = await issue(h, { ...resources, actions: ["artifacts.read"] });
    const payloads = new Map<string, Uint8Array>();
    for (const reference of completed.artifacts) {
      assert.deepEqual(Object.keys(reference).sort(), [
        "artifactId",
        "endpoint",
        "scope",
        "sha256",
        "size",
      ]);
      assert.equal(reference.endpoint, `/v1/admin/artifacts/${reference.artifactId}`);
      assert.deepEqual(
        reference.scope,
        reference.scope.kind === "agent"
          ? { kind: "agent", agentId: agent.agentId, conversationIds: [cid] }
          : { kind: "workspace", workspaceId: binding.workspaceId, revision: binding.revision },
      );
      payloads.set(reference.artifactId, await download(h, reference, reader));
    }
    const agentRef = completed.artifacts.find((reference) => reference.scope.kind === "agent");
    assert.ok(agentRef);
    const text = new TextDecoder().decode(payloads.get(agentRef.artifactId));
    const records = text
      .trimEnd()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            type: string;
            conversationId?: string;
            message?: D.Message;
            entry?: unknown;
          },
      );
    assert.equal(records[0]?.type, "fortipi.agent.export");
    assert.ok(
      records.some(
        (record) =>
          record.type === "entry" &&
          JSON.stringify(record.entry).includes("answer:file-backup-before-cut"),
      ),
      "Actual committed Pi entry must be retained",
    );
    assert.deepEqual(
      records.filter((record) => record.type === "message").map((record) => record.message),
      before.messages,
    );
    assert.ok(
      records
        .filter((record) => record.conversationId)
        .every((record) => record.conversationId === cid),
    );
    for (const omitted of [
      "outside-export-scope",
      excluded.body.conversationId,
      unselected.workspaceId,
      bootstrap,
      creator,
      reader,
      writer,
    ])
      for (const bytes of payloads.values())
        assert.equal(new TextDecoder().decode(bytes).includes(omitted), false);
    const workspaceRefs = completed.artifacts.filter(
      (reference) => reference.scope.kind === "workspace",
    );
    const indexRef = workspaceRefs[0];
    assert.ok(indexRef);
    const index = JSON.parse(new TextDecoder().decode(payloads.get(indexRef.artifactId))) as {
      version: number;
      workspaceId: string;
      revision: string;
      manifestHash: string;
      manifest: D.Manifest;
      files: {
        path: string;
        parts: { artifactId: string; offset: number; size: number; sha256: string }[];
      }[];
    };
    assert.deepEqual(Object.keys(index).sort(), [
      "files",
      "manifest",
      "manifestHash",
      "revision",
      "version",
      "workspaceId",
    ]);
    assert.equal(index.version, 1);
    assert.equal(index.workspaceId, binding.workspaceId);
    assert.equal(index.revision, binding.revision);
    assert.equal(index.manifestHash, binding.manifestHash);
    assert.equal(await manifestDigest(index.manifest), binding.manifestHash);
    assert.equal(index.files.length, 1);
    assert.equal(index.files[0]?.path, "file-000.txt");
    const part = index.files[0]?.parts[0];
    assert.ok(part);
    // CP copies retain the source IDs in the immutable index, and assign new
    // public artifact IDs. Match content identities rather than invent a rewrite.
    const member = workspaceRefs.find(
      (reference) => reference.sha256 === part.sha256 && reference.size === part.size,
    );
    assert.ok(member);
    assert.equal(part.offset, 0);
    assert.equal(part.size, canonical.length);
    assert.deepEqual(payloads.get(member.artifactId), canonical);
    const source = await observation(h, binding.workspaceId);
    assert.deepEqual(
      source.resources,
      scope({ workspaceIds: [binding.workspaceId], actions: ["backups.create"] }),
    );
    assert.ok(source.result.ok);
    if (source.result.ok)
      assert.ok(
        source.result.value.artifacts.some((reference) => reference.artifactId === part.artifactId),
      );

    assert.equal((await h.api(member.endpoint, undefined, "GET", creator)).status, 403);
    const agentOnly = await issue(
      h,
      scope({
        agentIds: [agent.agentId],
        conversationIds: [cid],
        actions: ["artifacts.read", "operations.read"],
      }),
    );
    assert.equal((await h.api(member.endpoint, undefined, "GET", agentOnly)).status, 403);
    assert.equal((await h.api(endpoint, undefined, "GET", agentOnly)).status, 403);
    const workspaceOnly = await issue(
      h,
      scope({ workspaceIds: [binding.workspaceId], actions: ["artifacts.read"] }),
    );
    assert.equal((await h.api(agentRef.endpoint, undefined, "GET", workspaceOnly)).status, 403);
    const broadened = await h.api(
      "/v1/admin/backups",
      {
        ...input,
        requestId: crypto.randomUUID(),
        resources: {
          ...resources,
          workspaceIds: [...resources.workspaceIds, unselected.workspaceId],
        },
      },
      "POST",
      creator,
    );
    assert.equal(broadened.status, 403);
    assert.equal((await h.api(`/v1/conversations/${cid}`, undefined, "GET", reader)).status, 403);
    assert.equal(
      (
        await h.api(
          `/v1/workspaces/${binding.workspaceId}/read?revision=${binding.revision}&path=file-000.txt`,
          undefined,
          "GET",
          reader,
        )
      ).status,
      403,
    );

    const next = await computerBase(h, binding, writer, 2);
    assert.notEqual(next.revision, binding.revision);
    await append(h, cid, "file-backup-after-cut", actor);
    const retry = await h.api<D.AdminOperation>("/v1/admin/backups", input, "POST", creator);
    assert.equal(retry.status, 202);
    assert.deepEqual(retry.body, completed);
    for (const reference of completed.artifacts)
      assert.deepEqual(await download(h, reference, reader), payloads.get(reference.artifactId));
    const changed = await h.api(
      "/v1/admin/backups",
      { ...input, maxBytes: input.maxBytes - 1 },
      "POST",
      creator,
    );
    assert.equal(changed.status, 409);
  } finally {
    await h.close();
  }
});

test("a genuinely partial file-bearing Workspace cannot publish a completed public backup", {
  timeout: 60000,
}, async () => {
  const h = await open();
  try {
    const empty = await workspace(h, { kind: "computer" });
    const writer = await issue(
      h,
      scope({
        workspaceIds: [empty.workspaceId],
        backendIds: [empty.workspaceId],
        actions: ["workspace.write"],
      }),
    );
    const binding = await computerBase(h, empty, writer, 1);
    const { completed } = await operation(h, scope({ workspaceIds: [binding.workspaceId] }), 1);
    assert.equal(completed.state, "unavailable");
    assert.deepEqual(completed.artifacts, []);
    const source = await observation(h, binding.workspaceId);
    assert.equal(source.maxBytes, 1);
    assert.ok(source.result.ok);
    if (!source.result.ok) assert.fail("Expected actual partial producer result");
    assert.equal(source.result.value.state, "partial");
    assert.deepEqual(source.result.value.artifacts, []);
    assert.deepEqual(source.result.value.unavailableWorkspaceIds, [binding.workspaceId]);
  } finally {
    await h.close();
  }
});

test("an unavailable local Workspace keeps a real Pi aggregate unavailable without publishing a subset", {
  timeout: 60000,
}, async () => {
  const h = await open();
  try {
    const { agent, conversation } = await setup(h);
    await append(h, conversation.conversationId, "available-agent-unavailable-workspace");
    const executorId = crypto.randomUUID();
    await issue(
      h,
      scope({ executorIds: [executorId], actions: ["tickets.mint", "executors.register"] }),
      executorId,
    );
    const binding = await workspace(h, {
      kind: "local",
      executorId,
      rootBindingId: "offline-root",
    });
    const { completed } = await operation(
      h,
      scope({
        agentIds: [agent.agentId],
        conversationIds: [conversation.conversationId],
        workspaceIds: [binding.workspaceId],
      }),
    );
    assert.equal(completed.state, "unavailable");
    assert.deepEqual(completed.artifacts, []);
    const source = await observation(h, binding.workspaceId);
    assert.ok(source.result.ok);
    if (!source.result.ok) assert.fail("Expected actual unavailable producer result");
    assert.equal(source.result.value.state, "unavailable");
    assert.deepEqual(source.result.value.artifacts, []);
    assert.deepEqual(source.result.value.unavailableWorkspaceIds, [binding.workspaceId]);
  } finally {
    await h.close();
  }
});
