import assert from "node:assert/strict";
import {
  ExecutorRuntime,
  HttpTransport,
  SessionTransport,
} from "../../../../packages/fortipi-executor/dist/index.js";
import { fixture } from "../../../../packages/fortipi-executor/test/fixtures/daemon.ts";
import type * as D from "../../src/boundary/dto.js";
import { eventually, type harness } from "../agent/harness.ts";

/** A second real connected daemon, with an independent root/ledger and the same committed Computer input. */
export async function routingPeer(
  h: Awaited<ReturnType<typeof harness>>,
  binding: D.WorkspaceBinding,
  agentId: string,
  conversationId: string,
) {
  const f = await fixture(),
    executorId = crypto.randomUUID(),
    stop = new AbortController();
  let runtime: ExecutorRuntime | undefined, connection: Promise<void> | undefined;
  const close = async () => {
    stop.abort();
    await connection;
    await runtime?.shutdown();
    await f.cleanup();
  };
  try {
    const resources: D.ResourceScope = {
      agentIds: [agentId],
      conversationIds: [conversationId],
      workspaceIds: [binding.workspaceId],
      executorIds: [executorId],
      backendIds: [],
      tools: ["shell"],
      actions: [
        "tickets.mint",
        "executors.register",
        "transfers.input",
        "transfers.output",
        "transfers.status",
        "workspace.read",
        "workspace.write",
        "artifacts.read",
      ],
    };
    const issued = await h.api<D.CredentialReceipt>("/v1/admin/credentials", {
      requestId: crypto.randomUUID(),
      role: "executor",
      executorId,
      expiresAt: Date.now() + 240000,
      grants: [{ grantId: crypto.randomUUID(), version: 1, resources }],
    });
    assert.equal(issued.status, 201);
    assert.equal(issued.body.state, "issued");
    if (issued.body.state !== "issued") throw new Error("Expected fixture credential");
    const { url } = await h.server.listen();
    const protocol = await h.api<D.Protocol>("/v1/protocol");
    Object.assign(f.profile, {
      origin: new URL(url).origin,
      deploymentId: protocol.body.deploymentId,
      executorId,
      executorGeneration: 1,
      credential: issued.body.credential,
      token: issued.body.token,
      resources,
    });
    f.profile.bindings = [
      {
        rootBindingId: "root",
        workspaceId: binding.workspaceId,
        bindingVersion: binding.bindingVersion,
        path: f.rootPath,
        revision: binding.revision,
        manifestHash: binding.manifestHash,
        providerKind: "computer",
      },
    ];
    runtime = new ExecutorRuntime({
      profile: f.profile,
      ledger: f.ledger,
      directory: f.directory,
      roots: new Map([["root", f.root]]),
      http: new HttpTransport(f.profile, fetch, true),
    });
    await runtime.initialize();
    const session = new SessionTransport(runtime.http, runtime);
    runtime.session = session;
    connection = session
      .connect(stop.signal, {
        type: "executor.register",
        requestId: crypto.randomUUID(),
        payload: {
          executorId,
          generation: 1,
          ...runtime.http.ledgerIdentity(),
          protocolVersion: "1.0",
          schemaVersion: "1.0.0",
          platform: process.platform as "darwin" | "linux" | "win32",
          caseBehavior: f.root.identity.caseBehavior,
          confinement: "host",
          capabilities: ["shell", "local-workspace", "snapshots"],
          rootBindingIds: ["root"],
          transferLimits: runtime.http.transferLimits(),
        },
      })
      .catch(() => {});
    await eventually(async () => runtime!.connected, Boolean);
    return { executorId, runtime, f, close };
  } catch (error) {
    await close();
    throw error;
  }
}
