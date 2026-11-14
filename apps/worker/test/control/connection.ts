import assert from "node:assert/strict";
import { manifestDigest } from "fortipi-contract";
import type { ControlPlaneRpc } from "../../src/boundary/control-plane.js";
import type * as D from "../../src/boundary/dto.js";
import { type harness, request, scope, uuid, value } from "./harness.ts";

export async function connected(
  h: Pick<Awaited<ReturnType<typeof harness>>, "mint" | "auth" | "server"> & {
    cp: Pick<Awaited<ReturnType<typeof harness>>["cp"], "mintTicket">;
  },
  options: {
    workspaceIds?: string[];
    transferLimits?: D.ExecutorTransferLimits;
    generation?: number;
    executorId?: string;
  } = {},
) {
  const executorId = options.executorId ?? "executor";
  const resources = {
    ...scope(),
    executorIds: [executorId],
    ...(options.workspaceIds ? { workspaceIds: options.workspaceIds } : {}),
  };
  const issued = await h.mint({
    requestId: uuid(),
    role: "executor",
    executorId,
    grants: [{ grantId: "executor", version: 1, resources }],
  });
  const executor = await h.auth(issued.token);
  const minted = value(
    await h.cp.mintTicket(
      executor,
      request("mintConnectionTicket", {
        requestId: uuid(),
        audience: "executor-session",
        resources,
        originMode: { kind: "native" },
        executor: { executorId, generation: options.generation ?? 1 },
      }),
    ),
  );
  if (minted.status !== 201) assert.fail("No executor ticket");
  const { url: listenUrl } = await h.server.listen();
  const url = new URL(listenUrl);
  url.protocol = "ws:";
  url.pathname = "/v1/executor/session";
  url.searchParams.set("ticket", minted.body.ticket);
  const socket = new WebSocket(url.toString());
  const frames: D.ExecutorFrame[] = [];
  const waiters: (() => void)[] = [];
  socket.addEventListener("message", (event) => {
    frames.push(JSON.parse(String(event.data)) as D.ExecutorFrame);
    for (const wake of waiters.splice(0)) wake();
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("Executor socket failed")), {
      once: true,
    });
  });
  const send = (frame: D.ExecutorFrame): void => socket.send(JSON.stringify(frame));
  const wait = async (
    type: D.ExecutorFrame["type"],
    matches: (frame: D.ExecutorFrame) => boolean = () => true,
  ): Promise<D.ExecutorFrame> => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const frame = frames.find((f) => f.type === type && matches(f));
      if (frame) return frame;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 20);
        waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    assert.fail(`Missing ${type}`);
  };
  send({
    type: "executor.register",
    requestId: uuid(),
    payload: {
      executorId,
      generation: options.generation ?? 1,
      protocolVersion: "1.0",
      schemaVersion: "1.0.0",
      capabilities: ["shell"],
      platform: "linux",
      caseBehavior: "sensitive",
      rootBindingIds: ["root"],
      confinement: "host",
      transferLimits: options.transferLimits ?? {
        chunkBytes: 262144,
        fileBytes: 4194304,
        snapshotBytes: 16777216,
        artifactBytes: 1048576,
        manifestEntries: 512,
      },
    },
  });
  const registered = await wait("executor.registered");
  if (registered.type !== "executor.registered") assert.fail("Not registered");
  return {
    socket,
    frames,
    send,
    wait,
    issued,
    executor,
    epoch: registered.payload.connectionEpoch,
  };
}
export async function localBinding(
  h: Awaited<ReturnType<typeof harness>>,
  channel: Awaited<ReturnType<typeof connected>>,
  manifest: D.Manifest,
  revision: string,
) {
  const admin = await h.auth();
  const api = h.cp as unknown as Pick<ControlPlaneRpc, "handleApi">;
  const created = value(
    await api.handleApi(
      admin,
      request("createWorkspace", {
        requestId: uuid(),
        config: { kind: "local", executorId: "executor", rootBindingId: "root" },
      }),
    ),
  );
  if (created.status !== 201) assert.fail("No binding");
  const workspaceId = created.body.workspaceId;
  const closed = new Promise<void>((resolve) =>
    channel.socket.addEventListener("close", () => resolve(), { once: true }),
  );
  channel.socket.close();
  await closed;
  channel = await connected(h, { workspaceIds: [workspaceId] });
  const manifestHash = await manifestDigest(manifest);
  const applying = api.handleApi(
    admin,
    request(
      "rebindWorkspace",
      {
        requestId: uuid(),
        expectedVersion: 1,
        newBindingVersion: 2,
        config: { kind: "local", executorId: "executor", rootBindingId: "root" },
        import: { revision, manifest, acknowledgeExternalEffects: true },
      },
      { workspaceId },
    ),
  );
  const frame = await channel.wait("workspace.request");
  if (frame.type !== "workspace.request") assert.fail("No retained snapshot request");
  channel.send({
    type: "workspace.response",
    requestId: frame.requestId,
    payload: {
      requestId: frame.payload.requestId,
      correlationId: frame.payload.correlationId,
      response: { kind: "snapshot", result: { workspaceId, revision, manifestHash, manifest } },
    },
  });
  value(await applying);
  channel.frames.splice(0);
  const resources = {
    ...scope(["workspace.read", "workspace.write"]),
    workspaceIds: [workspaceId],
  };
  const credential = {
    credentialId: admin.credentialId,
    generation: admin.generation,
    grantVersion: admin.grantVersion,
  };
  const registration = value(
    await h.cp.registerAuthorityRecipient(admin, {
      credential,
      recipient: { kind: "workspace", id: workspaceId },
      resources,
      executor: { executorId: "executor", generation: 1 },
    }),
  );
  return {
    workspaceId,
    revision,
    manifestHash,
    resources,
    credential,
    ctx: { ...admin, registrationId: registration.registrationId },
    channel,
  };
}
