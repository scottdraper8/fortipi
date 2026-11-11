import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type * as D from "../../src/boundary/dto.js";
import { bootstrap, eventually, harness, setup } from "./harness.ts";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
test("Agent export retains actual immutable Pi payload under exact logical authority without read grants", async () => {
  const h = await harness();
  try {
    const { agent, conversation } = await setup(h),
      probe = h.env.AGENT_SESSIONS.getByName(agent.agentId),
      cp = h.env.CONTROL_PLANE.getByName("control");
    const path = `/v1/conversations/${conversation.conversationId}`;
    const append = async (content: string) => {
      const sent = await h.api(`${path}/messages`, {
        clientRequestId: crypto.randomUUID(),
        content,
        busyBehavior: "followUp",
      });
      assert.equal(sent.status, 202);
      await eventually(
        () => h.api<D.ConversationProjection>(path),
        (value) =>
          value.status === 200 &&
          value.body.messages.some((message) => message.content === `answer:${content}`),
      );
    };
    await append("retained-export-before-cut");
    await probe.seedExcludedExportRecords();
    const resources: D.ResourceScope = {
      agentIds: [agent.agentId],
      conversationIds: [conversation.conversationId],
      workspaceIds: [],
      executorIds: [],
      backendIds: [],
      tools: [],
      actions: ["exports.create"],
    };
    const issued = await h.api<D.CredentialReceipt>("/v1/admin/credentials", {
      requestId: crypto.randomUUID(),
      role: "admin",
      grants: [{ grantId: crypto.randomUUID(), version: 1, resources }],
    });
    assert.equal(issued.status, 201);
    assert.equal(issued.body.state, "issued");
    if (issued.body.state !== "issued") assert.fail("Expected local synthetic export credential");
    const authenticated = await cp.authenticate({
      bearer: issued.body.token,
      deploymentId: h.env.CONTROL_PLANE.idFromName("control").toString(),
      requestId: crypto.randomUUID(),
      deadline: Date.now() + 30000,
    });
    assert.ok(authenticated.ok);
    if (!authenticated.ok) assert.fail("Actual export authentication failed");
    const principal = authenticated.value;
    const registered = await cp.registerAuthorityRecipient(principal, {
      credential: {
        credentialId: principal.credentialId,
        generation: principal.generation,
        grantVersion: principal.grantVersion,
      },
      recipient: { kind: "agent", id: agent.agentId },
      resources,
    });
    assert.ok(registered.ok);
    if (!registered.ok) assert.fail("Actual export registration failed");
    const auth = { ...principal, registrationId: registered.value.registrationId };
    const input: D.ExportRequest = {
      exportId: crypto.randomUUID(),
      action: "exports.create",
      resources,
      maxBytes: 1048576,
      deadline: Date.now() + 30000,
    };
    const prepare = async (request: D.ExportRequest) =>
      JSON.parse(await probe.exportDataJson(auth, request)) as D.Outcome<D.ExportDescriptor>;
    const prepared = await prepare(input);
    assert.ok(prepared.ok, JSON.stringify(prepared.ok ? {} : prepared));
    if (!prepared.ok) assert.fail("Export failed");
    assert.equal(prepared.value.state, "ready");
    assert.equal(prepared.value.artifacts.length, 1);
    const artifact = prepared.value.artifacts[0];
    assert.ok(artifact && "scope" in artifact);
    if (!artifact || !("scope" in artifact))
      assert.fail("Actual admin artifact reference required");
    assert.deepEqual(artifact.scope, {
      kind: "agent",
      agentId: agent.agentId,
      conversationIds: [conversation.conversationId],
    });
    const read = async (range?: string) =>
      probe.fetch(
        new Request(`https://agent.internal${artifact.endpoint}`, {
          headers: {
            "X-Fortipi-Context": JSON.stringify(auth),
            ...(range ? { Range: range } : {}),
          },
        }),
      );
    const response = await read();
    assert.equal(response.status, 200);
    const bytes = new Uint8Array(await response.arrayBuffer()),
      text = new TextDecoder().decode(bytes);
    const records = text
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string });
    assert.equal(records[0]?.type, "fortipi.agent.export");
    assert.ok(records.some((record) => record.type === "entry"));
    assert.ok(records.some((record) => record.type === "message"));
    assert.equal(bytes.length, artifact.size);
    assert.equal(sha(bytes), artifact.sha256);
    assert.equal(response.headers.get("X-Content-SHA256"), artifact.sha256);
    assert.ok(text.includes("retained-export-before-cut"));
    assert.ok(text.includes('"type":"entry"'));
    assert.ok(text.includes('"type":"message"'));
    for (const excluded of [
      "synthetic-excluded-access-sentinel",
      "synthetic-excluded-refresh-sentinel",
      "synthetic-excluded-provider-sentinel",
      issued.body.token,
      bootstrap,
    ])
      assert.equal(
        text.includes(excluded),
        false,
        "Authority/provider material must never enter retained payload",
      );
    await append("retained-export-after-cut");
    const retry = await prepare(input);
    assert.deepEqual(retry, prepared);
    const repeated = new Uint8Array(await (await read()).arrayBuffer());
    assert.deepEqual(repeated, bytes);
    assert.equal(new TextDecoder().decode(repeated).includes("retained-export-after-cut"), false);
    const range = await read("bytes=3-31");
    assert.equal(range.status, 206);
    const slice = new Uint8Array(await range.arrayBuffer());
    assert.deepEqual(slice, bytes.slice(3, 32));
    assert.equal(range.headers.get("X-Content-SHA256"), sha(slice));
    const backup = await prepare({
      ...input,
      exportId: crypto.randomUUID(),
      action: "backups.create",
    });
    assert.equal(backup.ok, false);
    const broadened = await prepare({
      ...input,
      exportId: crypto.randomUUID(),
      resources: { ...resources, agentIds: [agent.agentId, "ungranted-agent"] },
    });
    assert.equal(
      broadened.ok,
      false,
      "Producer must authorize the complete requested scope without rewriting it to own Agent only",
    );
    const split = await h.api<D.CredentialReceipt>("/v1/admin/credentials", {
      requestId: crypto.randomUUID(),
      role: "admin",
      grants: [
        {
          grantId: crypto.randomUUID(),
          version: 1,
          resources: { ...resources, conversationIds: [] },
        },
        { grantId: crypto.randomUUID(), version: 1, resources: { ...resources, agentIds: [] } },
      ],
    });
    assert.equal(split.status, 201);
    if (split.body.state !== "issued") assert.fail("Expected split-grant local credential");
    const splitAuth = await cp.authenticate({
      bearer: split.body.token,
      deploymentId: auth.deploymentId,
      requestId: crypto.randomUUID(),
      deadline: Date.now() + 30000,
    });
    assert.ok(splitAuth.ok);
    if (!splitAuth.ok) assert.fail("Split authentication unavailable");
    const splitRegistration = await cp.registerAuthorityRecipient(splitAuth.value, {
      credential: {
        credentialId: splitAuth.value.credentialId,
        generation: splitAuth.value.generation,
        grantVersion: splitAuth.value.grantVersion,
      },
      recipient: { kind: "agent", id: agent.agentId },
      resources: { ...resources, conversationIds: [] },
    });
    assert.ok(splitRegistration.ok);
    if (!splitRegistration.ok) assert.fail("Agent-only registration unavailable");
    const rejected = JSON.parse(
      await probe.exportDataJson(
        { ...splitAuth.value, registrationId: splitRegistration.value.registrationId },
        { ...input, exportId: crypto.randomUUID() },
      ),
    ) as D.Outcome<D.ExportDescriptor>;
    assert.equal(rejected.ok, false, "Split grants must not union into full export authority");
    const changed = await prepare({ ...input, maxBytes: input.maxBytes - 1 });
    assert.equal(changed.ok, false);
    if (!changed.ok) assert.equal(changed.code, "conflict");
    const metadata = await prepare({
      ...input,
      exportId: crypto.randomUUID(),
      resources: { ...resources, conversationIds: [] },
    });
    assert.ok(metadata.ok);
    if (metadata.ok) {
      assert.equal(metadata.value.state, "ready");
      const ref = metadata.value.artifacts[0];
      assert.ok(ref && "scope" in ref);
      if (ref && "scope" in ref)
        assert.deepEqual(ref.scope, { kind: "agent", agentId: agent.agentId, conversationIds: [] });
    }
    const publicSpoof = await h.server.fetch(`http://fortipi.local${artifact.endpoint}`, {
      headers: { "X-Fortipi-Context": JSON.stringify(auth) },
    });
    assert.equal(
      publicSpoof.status,
      401,
      "External canonical-context spoof must not reach peer bytes",
    );
    const publicNoRead = await h.api(artifact.endpoint, undefined, "GET", issued.body.token);
    assert.equal(
      publicNoRead.status,
      403,
      "Logical export authority must not bypass public artifacts.read",
    );
  } finally {
    await h.close();
  }
});
