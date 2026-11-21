import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import type { ExecutorFrame } from "fortipi-contract/executor";
import { assignmentDigest, operationDigest, validateAssignment } from "fortipi-contract/executor";
import { AdminClient } from "../../../../packages/fortipi-cli/dist/admin.js";
import { issueCredential } from "../../../../packages/fortipi-cli/dist/credentials.js";
import type { Profile } from "../../../../packages/fortipi-executor/dist/config.js";
import {
  adapter,
  defaults,
  loadProfile,
  privateRead,
  privateWrite,
  secureDirectory,
} from "../../../../packages/fortipi-executor/dist/config.js";
import { ExecutorRuntime } from "../../../../packages/fortipi-executor/dist/daemon.js";
import { Ledger } from "../../../../packages/fortipi-executor/dist/ledger.js";
import { childEnvironment } from "../../../../packages/fortipi-executor/dist/platform/types.js";
import {
  configureProfile,
  initializeProfile,
} from "../../../../packages/fortipi-executor/dist/provision.js";
import {
  HttpFailure,
  HttpTransport,
  SessionTransport,
} from "../../../../packages/fortipi-executor/dist/transport.js";
import {
  assignment,
  eventually,
  nodeCommand,
} from "../../../../packages/fortipi-executor/test/fixtures/daemon.ts";
import type { ExecutorState } from "../../src/control/tickets.ts";
import type { TestControlPlane } from "../control/fixtures/executor-ledger.ts";
import { bootstrap, harness, request, scope, uuid, value } from "../control/harness.ts";

async function state(
  h: Awaited<ReturnType<typeof harness<TestControlPlane>>>,
  id: string,
): Promise<ExecutorState | undefined> {
  return JSON.parse(await h.cp.ledgerState(id)) ?? undefined;
}
const exec = promisify(execFile);
function registration(http: HttpTransport): Extract<ExecutorFrame, { type: "executor.register" }> {
  return {
    type: "executor.register",
    requestId: uuid(),
    payload: {
      executorId: http.profile.executorId,
      generation: http.profile.executorGeneration,
      ...http.ledgerIdentity(),
      protocolVersion: "1.0",
      schemaVersion: "1.0.0",
      platform: adapter().platform,
      caseBehavior: "sensitive",
      confinement: "host",
      capabilities: [],
      rootBindingIds: [],
      transferLimits: http.transferLimits(),
    },
  };
}
function peer(http: HttpTransport, runtime?: ExecutorRuntime) {
  const controller = new AbortController();
  const session = new SessionTransport(
    http,
    runtime ?? {
      async receive() {},
      async disconnected() {},
      reconnectFrames() {
        return [];
      },
    },
  );
  if (runtime) runtime.session = session;
  const result = session.connect(controller.signal, registration(http));
  void result.catch(() => {});
  return {
    session,
    async close() {
      controller.abort();
      await result.catch(() => {});
    },
  };
}
async function socket(http: HttpTransport, ticket: string): Promise<WebSocket> {
  const url = new URL("/v1/executor/session", http.profile.origin);
  url.protocol = "ws:";
  url.searchParams.set("ticket", ticket);
  const ws = new WebSocket(url.toString());
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("fixture upgrade refused")), {
      once: true,
    });
  });
  return ws;
}

test("actual issued protected envelope assembles disabled profile; real CP retains the opened instance across independent-host refusals and reopen", {
  timeout: 45000,
}, async () => {
  const h = await harness<TestControlPlane>({
    fixturePath: "apps/worker/test/control/fixtures/executor-ledger.ts",
  });
  const directory = await realpath(await mkdtemp(join(tmpdir(), "fortipi-provision-")));
  const platform = adapter();
  const ledgers: Ledger[] = [];
  const peers: ReturnType<typeof peer>[] = [];
  let runtime: ExecutorRuntime | undefined;
  try {
    await platform.protect(directory, true);
    const { url } = await h.server.listen(),
      origin = new URL(url).origin;
    const admin = new AdminClient(
      { version: 1, endpoint: origin, role: "admin", token: bootstrap },
      { allowLoopback: true },
    );
    const resources = {
      ...scope(["tickets.mint", "executors.register"]),
      workspaceIds: [],
      agentIds: [],
      conversationIds: [],
      tools: [],
      backendIds: [],
    };
    const credentialPath = join(directory, "issued.json");
    await issueCredential(admin, origin, credentialPath, {
      requestId: uuid(),
      role: "executor",
      executorId: "executor",
      expiresAt: Date.now() + 120000,
      grants: [{ grantId: uuid(), version: 1, resources }],
    });
    const issuedBefore = await privateRead(credentialPath);
    const device = {
      expectedDeploymentId: h.deploymentId,
      executorId: "executor",
      executorGeneration: 1,
      resources,
      bindings: [],
    };
    const input = join(directory, "device.json");
    await privateWrite(input, JSON.stringify(device), platform, true);
    const output = join(directory, "profile.json");
    const profile = await configureProfile(credentialPath, input, output, platform, true);
    assert.deepEqual(profile.policy, {
      version: 1,
      trustedHost: false,
      requireConfinement: false,
      rules: [],
    });
    assert.equal(profile.credentialExpiresAt, JSON.parse(issuedBefore).expiresAt);
    assert.equal(await privateRead(credentialPath), issuedBefore);
    assert.equal(
      (await state(h, "executor"))?.ledger?.kind,
      "unbound",
      "configuration performs no enrollment",
    );
    assert.equal((await state(h, "executor"))?.epoch, 0);
    await assert.rejects(configureProfile(credentialPath, input, output, platform, true), {
      code: "EEXIST",
    });
    const ledgerDirectory = join(directory, profile.ledgerId);
    await initializeProfile(profile, ledgerDirectory, platform, join(directory, "registry-one"));
    await assert.rejects(
      initializeProfile(profile, ledgerDirectory, platform, join(directory, "registry-one")),
      /already bound/,
    );
    let ledger = await Ledger.open(ledgerDirectory, profile.ledgerId, defaults);
    ledgers.push(ledger);
    const instance = ledger.ledgerInstanceId,
      incarnation = ledger.incarnation;
    let http = new HttpTransport(profile, fetch, true);
    http.bindLedger(ledger);
    runtime = new ExecutorRuntime({
      profile,
      ledger,
      directory: ledgerDirectory,
      roots: new Map(),
      http,
    });
    await runtime.initialize();
    let original = peer(http, runtime);
    peers.push(original);
    await eventually(() => original.session.registered, "actual workerd registration missing");
    assert.equal(runtime.connected, true);
    const first = await state(h, "executor");
    assert.deepEqual(first?.ledger, {
      kind: "bound",
      ledgerId: profile.ledgerId,
      ledgerInstanceId: instance,
    });
    // Direct Ledger/Node effect countercase (not a remotely dispatched job): persist the exact command before its effect.
    const marker = join(directory, "effects");
    const commandArgs = [
      "--input-type=module",
      "-e",
      "import{appendFileSync}from'node:fs';appendFileSync(process.argv[1],'one'+String.fromCharCode(10))",
      marker,
    ];
    const a = await assignment(nodeCommand(...commandArgs));
    a.operationContext.deploymentId = profile.deploymentId;
    const target = { kind: "executor" as const, executorId: "executor", generation: 1 };
    const operation = {
      deploymentId: profile.deploymentId,
      agentId: a.operationContext.agentId,
      conversationId: a.operationContext.conversationId,
      tool: a.tool,
      arguments: a.arguments,
      workspaceId: a.workspaceId,
      baseRevision: a.identity.baseRevision,
      target,
      policyVersion: a.operationContext.policyVersion,
      grantVersion: a.identity.lease.credential.grantVersion,
      deadline: a.identity.deadline,
    };
    a.identity.target = target;
    a.identity.lease.executorGeneration = 1;
    a.identity.operationDigest = await operationDigest(operation);
    a.identity.assignmentDigest = await assignmentDigest({
      operation,
      executionId: a.identity.executionId,
      reservationId: a.reservationId,
      leaseId: a.identity.lease.leaseId,
      fence: a.identity.lease.fence,
      executorGeneration: 1,
    });
    assert.ok(a.approval);
    a.approval.target = target;
    a.approval.operationDigest = a.identity.operationDigest;
    await validateAssignment(a);
    const admitted = ledger.admit(a, "canary");
    admitted.decision = "allow";
    ledger.put(admitted);
    assert.equal(ledger.claim(a.identity.jobId, "canary", "canary-root", a.identity.jobId), true);
    await exec(process.execPath, commandArgs, { env: childEnvironment() });
    for (const copied of [true, false]) {
      const independent = join(directory, copied ? "copied-profile" : "new-profile");
      await secureDirectory(independent);
      const clone: Profile = structuredClone(profile);
      if (!copied) clone.ledgerId = randomUUID();
      const path = join(independent, "profile.json");
      await privateWrite(path, JSON.stringify(clone), platform, true);
      const loaded = await loadProfile(path, platform, true);
      await initializeProfile(
        loaded,
        join(independent, loaded.ledgerId),
        platform,
        join(independent, "registry"),
      );
      const replacement = await Ledger.open(
        join(independent, loaded.ledgerId),
        loaded.ledgerId,
        defaults,
      );
      ledgers.push(replacement);
      assert.notEqual(replacement.ledgerInstanceId, instance);
      const foreign = new HttpTransport(loaded, fetch, true);
      foreign.bindLedger(replacement);
      await assert.rejects(
        foreign.ticket(),
        (error: unknown) => error instanceof HttpFailure && error.status === 409,
      );
      assert.deepEqual(
        await state(h, "executor"),
        first,
        "rejected empty-host replacement cannot advance epoch or replace original session",
      );
      assert.equal(original.session.registered, true);
      const presence = await h.cp.recoveredPresence("executor", 1);
      assert.ok(presence.ok && presence.value);
      assert.equal(ledger.get(a.identity.jobId)?.state, "start_intent");
      assert.equal(await readFile(marker, "utf8"), "one\n");
    }
    await original.close();
    await runtime.shutdown();
    ledger.close();
    ledger = await Ledger.open(ledgerDirectory, profile.ledgerId, defaults);
    ledgers.push(ledger);
    ledger.recover();
    assert.equal(ledger.ledgerInstanceId, instance);
    assert.notEqual(ledger.incarnation, incarnation);
    assert.equal(ledger.get(a.identity.jobId)?.state, "unknown");
    assert.equal(ledger.claim(a.identity.jobId, "canary", "canary-root", a.identity.jobId), false);
    http = new HttpTransport(profile, fetch, true);
    http.bindLedger(ledger);
    // Consume a real upgrade and registration, deliberately ignore its ACK; retry uses the SAME retained instance.
    const ignored = await socket(http, (await http.ticket()).ticket);
    ignored.send(JSON.stringify(registration(http)));
    await eventually(
      async () => (await state(h, "executor"))?.status === "online",
      "registration not committed",
    );
    ignored.close();
    runtime = new ExecutorRuntime({
      profile,
      ledger,
      directory: ledgerDirectory,
      roots: new Map(),
      http,
    });
    await runtime.initialize();
    original = peer(http, runtime);
    peers.push(original);
    await eventually(() => original.session.registered, "matching instance retry failed");
    assert.equal((await state(h, "executor"))?.ledger?.kind, "bound");
    assert.equal(runtime.children.size, 0);
    assert.equal(
      await readFile(marker, "utf8"),
      "one\n",
      "retained unknown effect must not be replayed",
    );
    assert.deepEqual(profile.policy, {
      version: 1,
      trustedHost: false,
      requireConfinement: false,
      rules: [],
    });
    assert.equal(await privateRead(output), JSON.stringify(profile));
  } finally {
    for (const p of peers) await p.close();
    if (runtime?.ledger.db.isOpen) await runtime.shutdown();
    for (const ledger of ledgers) if (ledger.db.isOpen) ledger.close();
    await h.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("real first-instance enrollment race, stale authority, legacy unknown and explicit execution-generation recovery fail before foreign fencing", {
  timeout: 45000,
}, async () => {
  const h = await harness<TestControlPlane>({
    fixturePath: "apps/worker/test/control/fixtures/executor-ledger.ts",
  });
  const directory = await realpath(await mkdtemp(join(tmpdir(), "fortipi-enrollment-")));
  const ledgers: Ledger[] = [];
  const sockets: WebSocket[] = [];
  try {
    await adapter().protect(directory, true);
    const { url } = await h.server.listen(),
      origin = new URL(url).origin;
    const adminContext = await h.auth();
    const mint = async (body: import("../../src/boundary/dto.ts").CredentialMint) => {
      const response = value(
        await h.cp.mintCredential(adminContext, request("mintCredential", body)),
      );
      assert.equal(response.status, 201);
      if (response.body.state !== "issued") assert.fail("Expected fresh fixture issuance");
      return response.body;
    };
    const resources = (executorId: string) => ({
      ...scope(["tickets.mint", "executors.register"]),
      executorIds: [executorId],
      agentIds: [],
      conversationIds: [],
      workspaceIds: [],
      backendIds: [],
      tools: [],
    });
    const make = async (
      executorId: string,
      ledgerId = uuid(),
      actions = ["tickets.mint", "executors.register"],
    ) => {
      const granted = { ...resources(executorId), actions };
      const issued = await mint({
        requestId: uuid(),
        role: "executor",
        executorId,
        grants: [{ grantId: uuid(), version: 1, resources: granted }],
      });
      const path = join(directory, uuid());
      await secureDirectory(path);
      const ledger = await Ledger.provision(path, ledgerId, defaults);
      ledgers.push(ledger);
      const profile: Profile = {
        version: 1,
        origin,
        deploymentId: h.deploymentId,
        executorId,
        executorGeneration: 1,
        credential: issued.credential,
        token: issued.token,
        ledgerId,
        bindings: [],
        resources: granted,
        limits: {},
        policy: { version: 1, trustedHost: false, requireConfinement: false, rules: [] },
      };
      const http = new HttpTransport(profile, fetch, true);
      http.bindLedger(ledger);
      return { issued, ledger, profile, http };
    };
    const a = await make("race"),
      b = await make("race", a.profile.ledgerId);
    const [ticketA, ticketB] = await Promise.all([a.http.ticket(), b.http.ticket()]);
    assert.deepEqual(
      (await state(h, "race"))?.ledger,
      { kind: "unbound" },
      "minting unused tickets must not enroll",
    );
    const raced = await Promise.allSettled([
      socket(a.http, ticketA.ticket),
      socket(b.http, ticketB.ticket),
    ]);
    assert.equal(raced.filter((r) => r.status === "fulfilled").length, 1);
    const index = raced.findIndex((r) => r.status === "fulfilled"),
      winner = index === 0 ? a : b,
      loser = index === 0 ? b : a;
    const accepted = raced[index];
    assert.ok(accepted?.status === "fulfilled");
    sockets.push(accepted.value);
    accepted.value.send(JSON.stringify(registration(winner.http)));
    await eventually(
      async () => (await state(h, "race"))?.status === "online",
      "winning first instance did not register",
    );
    const bound = await state(h, "race");
    assert.equal(bound?.epoch, 1);
    assert.deepEqual(bound?.ledger, { kind: "bound", ...winner.http.ledgerIdentity() });
    await assert.rejects(
      loser.http.ticket(),
      (e: unknown) => e instanceof HttpFailure && e.status === 409,
    );
    assert.deepEqual(await state(h, "race"), bound);
    // New credentials for E do not grant a new execution generation or clear its ledger.
    const remint = await make("race", winner.profile.ledgerId);
    assert.notEqual(remint.issued.credential.credentialId, winner.issued.credential.credentialId);
    await assert.rejects(
      remint.http.ticket(),
      (e: unknown) => e instanceof HttpFailure && e.status === 409,
    );
    assert.deepEqual((await state(h, "race"))?.ledger, bound?.ledger);
    const stale = await make("stale");
    stale.profile.executorGeneration = 2;
    await assert.rejects(
      stale.http.ticket(),
      (e: unknown) => e instanceof HttpFailure && e.status === 409,
    );
    assert.equal((await state(h, "stale"))?.epoch, 0);
    const scopeDenied = await make("no_registration", undefined, ["tickets.mint"]);
    await assert.rejects(
      scopeDenied.http.ticket(),
      (e: unknown) => e instanceof HttpFailure && e.status === 403,
    );
    assert.deepEqual((await state(h, "no_registration"))?.ledger, { kind: "unbound" });
    const foreignScope = await make("overscope");
    foreignScope.profile.resources = {
      ...foreignScope.profile.resources,
      workspaceIds: ["outside-grant"],
    };
    await assert.rejects(
      foreignScope.http.ticket(),
      (e: unknown) => e instanceof HttpFailure && e.status === 403,
    );
    assert.equal((await state(h, "overscope"))?.epoch, 0);
    const forged = await make("forged");
    const client = await mint({
      requestId: uuid(),
      role: "client",
      grants: [{ grantId: uuid(), version: 1, resources: forged.profile.resources }],
    });
    const forgedEnvelope = join(directory, "forged-envelope.json"),
      forgedInput = join(directory, "forged-device.json"),
      forgedOutput = join(directory, "forged-profile.json");
    await privateWrite(
      forgedEnvelope,
      JSON.stringify({
        version: 1,
        endpoint: origin,
        role: "executor",
        token: client.token,
        credential: client.credential,
      }),
    );
    await privateWrite(
      forgedInput,
      JSON.stringify({
        expectedDeploymentId: h.deploymentId,
        executorId: "forged",
        executorGeneration: 1,
        resources: forged.profile.resources,
        bindings: [],
      }),
    );
    const assembled = await configureProfile(
      forgedEnvelope,
      forgedInput,
      forgedOutput,
      adapter(),
      true,
    );
    await initializeProfile(
      assembled,
      join(directory, assembled.ledgerId),
      adapter(),
      join(directory, "forged-registry"),
    );
    const forgedLedger = await Ledger.open(
      join(directory, assembled.ledgerId),
      assembled.ledgerId,
      defaults,
    );
    ledgers.push(forgedLedger);
    const forgedHttp = new HttpTransport(assembled, fetch, true);
    forgedHttp.bindLedger(forgedLedger);
    await assert.rejects(
      forgedHttp.ticket(),
      (e: unknown) => e instanceof HttpFailure && e.status === 403,
    );
    assert.deepEqual((await state(h, "forged"))?.ledger, { kind: "unbound" });
    assert.equal((await state(h, "forged"))?.epoch, 0);
    const expiring = await make("expired");
    const expired = await mint({
      requestId: uuid(),
      role: "executor",
      executorId: "expired",
      expiresAt: Date.now() + 300,
      grants: [{ grantId: uuid(), version: 1, resources: expiring.profile.resources }],
    });
    expiring.profile.token = expired.token;
    expiring.profile.credential = expired.credential;
    await new Promise((r) => setTimeout(r, 350));
    await assert.rejects(
      expiring.http.ticket(),
      (e: unknown) => e instanceof HttpFailure && e.status === 401,
    );
    assert.deepEqual((await state(h, "expired"))?.ledger, { kind: "unbound" });
    assert.equal((await state(h, "expired"))?.epoch, 0);
    const oldShape = await fetch(new URL("/v1/connections/tickets", origin), {
      method: "POST",
      headers: {
        authorization: `Bearer ${winner.issued.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        requestId: uuid(),
        audience: "executor-session",
        resources: winner.profile.resources,
        originMode: { kind: "native" },
        executor: { executorId: "race", generation: 1 },
      }),
    });
    assert.equal(oldShape.status, 400);
    await oldShape.body?.cancel();
    assert.deepEqual(await state(h, "race"), bound);
    const legacy = await make("legacy");
    await h.cp.legacyExecutor("legacy");
    await assert.rejects(
      legacy.http.ticket(),
      (e: unknown) => e instanceof HttpFailure && e.status === 409,
    );
    assert.equal((await state(h, "legacy"))?.ledger, undefined);
    const revokeDuringMint = await make("mint_current");
    assert.equal(
      await h.cp.raceTicket(adminContext, await h.auth(revokeDuringMint.issued.token), {
        requestId: uuid(),
        audience: "executor-session",
        resources: revokeDuringMint.profile.resources,
        originMode: { kind: "native" },
        executor: {
          executorId: "mint_current",
          generation: 1,
          ...revokeDuringMint.http.ledgerIdentity(),
        },
      }),
      false,
    );
    assert.equal((await state(h, "mint_current"))?.epoch, 0);
    const delayed = await make("upgrade_current"),
      ticket = await delayed.http.ticket();
    const consumed = await h.cp.consumeTicket({
      ticket: ticket.ticket,
      deploymentId: h.deploymentId,
      audience: "executor-session",
      origin: { kind: "native" },
      destination: { kind: "control" },
    });
    assert.ok(consumed.ok);
    assert.equal(await h.cp.raceUpgrade(adminContext, consumed.value), false);
    assert.equal((await state(h, "upgrade_current"))?.epoch, 0);
    assert.deepEqual((await state(h, "upgrade_current"))?.ledger, { kind: "unbound" });
    const admin = new AdminClient(
      { version: 1, endpoint: origin, role: "admin", token: bootstrap },
      { allowLoopback: true },
    );
    await admin.call("revokeExecutor", {
      path: { id: "race" },
      query: {},
      body: { requestId: uuid(), expectedGeneration: 1 },
    });
    const revoked = await state(h, "race");
    assert.equal(revoked?.generation, 2);
    assert.deepEqual(revoked?.ledger, { kind: "unbound" });
    const next = await make("race");
    next.profile.executorGeneration = 2;
    const nextSocket = await socket(next.http, (await next.http.ticket()).ticket);
    sockets.push(nextSocket);
    nextSocket.send(JSON.stringify(registration(next.http)));
    await eventually(
      async () => (await state(h, "race"))?.status === "online",
      "explicit new generation failed",
    );
    assert.deepEqual((await state(h, "race"))?.ledger, {
      kind: "bound",
      ...next.http.ledgerIdentity(),
    });
    await assert.rejects(
      winner.http.ticket(),
      (e: unknown) => e instanceof HttpFailure && e.status === 409,
    );
  } finally {
    for (const s of sockets) s.close();
    for (const ledger of ledgers) if (ledger.db.isOpen) ledger.close();
    await h.close();
    await rm(directory, { recursive: true, force: true });
  }
});
