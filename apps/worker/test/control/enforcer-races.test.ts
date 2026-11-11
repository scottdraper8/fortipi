import assert from "node:assert/strict";
import test from "node:test";
import type * as D from "../../src/boundary/dto.js";
import type { TestControlPlane } from "./fixtures/enforcer-races.ts";
import { harness, request, scope, uuid, value } from "./harness.ts";

test("a consumed executor identity cannot attach after concurrent credential revocation", async () => {
  const h = await harness<TestControlPlane>({
    fixturePath: "apps/worker/test/control/fixtures/enforcer-races.ts",
  });
  try {
    const issued = await h.mint({
      requestId: uuid(),
      role: "executor",
      executorId: "executor",
      grants: [{ grantId: "executor", version: 1, resources: scope() }],
    });
    const ticket = value(
      await h.cp.mintTicket(
        await h.auth(issued.token),
        request("mintConnectionTicket", {
          requestId: uuid(),
          audience: "executor-session",
          resources: scope(),
          originMode: { kind: "native" },
          executor: { executorId: "executor", generation: 1 },
        }),
      ),
    );
    assert.equal(ticket.status, 201);
    const identity = value(
      await h.cp.consumeTicket({
        ticket: ticket.body.ticket,
        deploymentId: h.deploymentId,
        audience: "executor-session",
        origin: { kind: "native" },
        destination: { kind: "control" },
      }),
    );
    assert.equal(
      await h.cp.raceUpgrade(await h.auth(), identity),
      false,
      "completed credential revocation must prevent delayed attachment",
    );
  } finally {
    await h.close();
  }
});

test("registration cannot overwrite a concurrent durable executor revocation", async () => {
  const h = await harness<TestControlPlane>({
    fixturePath: "apps/worker/test/control/fixtures/enforcer-races.ts",
  });
  let socket: WebSocket | undefined;
  try {
    const issued = await h.mint({
      requestId: uuid(),
      role: "executor",
      executorId: "executor",
      grants: [{ grantId: "executor", version: 1, resources: scope() }],
    });
    const ticket = value(
      await h.cp.mintTicket(
        await h.auth(issued.token),
        request("mintConnectionTicket", {
          requestId: uuid(),
          audience: "executor-session",
          resources: scope(),
          originMode: { kind: "native" },
          executor: { executorId: "executor", generation: 1 },
        }),
      ),
    );
    assert.equal(ticket.status, 201);
    const { url: listenUrl } = await h.server.listen();
    const url = new URL(listenUrl);
    url.protocol = "ws:";
    url.pathname = "/v1/executor/session";
    url.searchParams.set("ticket", ticket.body.ticket);
    socket = new WebSocket(url.toString());
    socket.addEventListener("error", () => undefined);
    await new Promise<void>((resolve, reject) => {
      socket?.addEventListener("open", () => resolve(), { once: true });
      socket?.addEventListener("error", () => reject(new Error("Socket failed")), { once: true });
    });
    const frame: Extract<D.ExecutorFrame, { type: "executor.register" }> = {
      type: "executor.register",
      requestId: uuid(),
      payload: {
        executorId: "executor",
        generation: 1,
        protocolVersion: "1.0",
        schemaVersion: "1.0.0",
        capabilities: ["shell"],
        platform: "linux",
        caseBehavior: "sensitive",
        rootBindingIds: ["root"],
        confinement: "host",
        transferLimits: {
          chunkBytes: 262144,
          fileBytes: 4194304,
          snapshotBytes: 16777216,
          artifactBytes: 1048576,
          manifestEntries: 512,
        },
      },
    };
    const observed = await h.cp.raceRegistration(await h.auth(), frame);
    assert.equal(
      observed.generation,
      2,
      "concurrent registration must retain the durable revocation floor",
    );
    assert.equal(observed.status, "revoked");
    assert.equal(observed.registrationSucceeded, false);
  } finally {
    socket?.close();
    await h.close();
  }
});
