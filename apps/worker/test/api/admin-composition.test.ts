import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type * as D from "../../src/boundary/dto.js";
import { eventually, harness, setup } from "../agent/harness.ts";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
test("public CP backup copies actual Pi Agent and empty Workspace producers under logical-only creation authority", {
  timeout: 35000,
}, async () => {
  const h = await harness();
  try {
    const { agent, conversation } = await setup(h),
      path = `/v1/conversations/${conversation.conversationId}`;
    const append = async (content: string) => {
      const sent = await h.api(`${path}/messages`, {
        clientRequestId: crypto.randomUUID(),
        content,
        busyBehavior: "followUp",
      });
      assert.equal(sent.status, 202);
      await eventually(
        () => h.api<D.ConversationProjection>(path),
        (view) => view.body.messages.some((m) => m.content === `answer:${content}`),
      );
    };
    await append("actual-backup-before-cut");
    await h.env.AGENT_SESSIONS.getByName(agent.agentId).seedExcludedExportRecords();
    const workspace = await h.api<D.WorkspaceBinding>("/v1/workspaces", {
      requestId: crypto.randomUUID(),
      config: { kind: "computer" },
    });
    assert.equal(workspace.status, 201);
    const resources: D.ResourceScope = {
      agentIds: [agent.agentId],
      conversationIds: [conversation.conversationId],
      workspaceIds: [workspace.body.workspaceId],
      executorIds: [],
      backendIds: [],
      tools: [],
      actions: [],
    };
    const issue = async (actions: string[]) => {
      const receipt = await h.api<D.CredentialReceipt>("/v1/admin/credentials", {
        requestId: crypto.randomUUID(),
        role: "admin",
        grants: [
          { grantId: crypto.randomUUID(), version: 1, resources: { ...resources, actions } },
        ],
      });
      assert.equal(receipt.status, 201);
      if (receipt.body.state !== "issued") assert.fail("Actual scoped local credential required");
      return receipt.body;
    };
    const creator = await issue(["backups.create"]),
      reader = await issue(["operations.read", "artifacts.read"]),
      input: D.ExportInput = { requestId: crypto.randomUUID(), resources, maxBytes: 1048576 };
    const started = await h.api<D.AdminOperation>(
      "/v1/admin/backups",
      input,
      "POST",
      creator.token,
    );
    assert.equal(started.status, 202, JSON.stringify(started.body));
    assert.deepEqual(await h.api("/v1/admin/backups", input, "POST", creator.token), started);
    const view = await eventually(
      () =>
        h.api<D.AdminOperation>(
          `/v1/admin/operations/${started.body.operationId}`,
          undefined,
          "GET",
          reader.token,
        ),
      (value) => ["completed", "failed", "unavailable"].includes(value.body.state),
    );
    assert.equal(view.status, 200);
    assert.equal(view.body.state, "completed", JSON.stringify(view.body));
    assert.equal(view.body.artifacts.length, 2);
    assert.deepEqual(view.body.artifacts.map((a) => a.scope.kind).sort(), ["agent", "workspace"]);
    await append("actual-backup-after-cut");
    for (const reference of view.body.artifacts) {
      const denied = await h.server.fetch(`http://fortipi.local${reference.endpoint}`, {
        headers: { Authorization: `Bearer ${creator.token}` },
      });
      assert.equal(denied.status, 403);
      const downloaded = await h.server.fetch(`http://fortipi.local${reference.endpoint}`, {
        headers: { Authorization: `Bearer ${reader.token}` },
      });
      assert.equal(downloaded.status, 200);
      const bytes = new Uint8Array(await downloaded.arrayBuffer());
      assert.equal(bytes.byteLength, reference.size);
      assert.equal(sha(bytes), reference.sha256);
      const payload = new TextDecoder().decode(bytes);
      assert.equal(payload.includes("synthetic-excluded-"), false);
      assert.equal(payload.includes(creator.token), false);
      assert.equal(payload.includes(reader.token), false);
      if (reference.scope.kind === "agent") {
        assert.deepEqual(reference.scope.conversationIds, [conversation.conversationId]);
        assert.ok(payload.includes("actual-backup-before-cut"));
        assert.equal(payload.includes("actual-backup-after-cut"), false);
      } else {
        assert.equal(reference.scope.workspaceId, workspace.body.workspaceId);
        assert.ok(payload.length > 0, "Actual empty-revision metadata still has retained bytes");
      }
    }
  } finally {
    await h.close();
  }
});
