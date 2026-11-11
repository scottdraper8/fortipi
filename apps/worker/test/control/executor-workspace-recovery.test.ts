import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import test from "node:test";
import { manifestDigest } from "fortipi-contract";
import type { ControlPlaneRpc } from "../../src/boundary/control-plane.js";
import type * as D from "../../src/boundary/dto.js";
import { assignedJob } from "./artifact-job.ts";
import { bootstrap, config, request, scope, uuid, value } from "./harness.ts";

test("assigned upload and seal recover the same retained identities after accepted lost replies and actual runtime-tree SIGKILL", {
  timeout: 45000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "fortipi-executor-upload-reopen-"));
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  const base = `http://127.0.0.1:${port}`,
    configPath = join(directory, "wrangler.json");
  let child: ChildProcess | undefined, socket: WebSocket | undefined;
  const stop = async () => {
    const running = child;
    child = undefined;
    if (!running || running.exitCode !== null || running.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => running.once("exit", () => resolve()));
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/PID", String(running.pid), "/T", "/F"], {
        stdio: "ignore",
      });
      await new Promise<void>((resolve) => killer.once("exit", () => resolve()));
    } else if (running.pid) process.kill(-running.pid, "SIGKILL");
    await exited;
  };
  try {
    await writeFile(
      configPath,
      JSON.stringify({
        name: "executor-workspace-recovery",
        main: resolve("apps/worker/test/control/fixtures/executor-workspace.ts"),
        compatibility_date: "2026-11-10",
        compatibility_flags: [
          "nodejs_compat",
          "enable_request_signal",
          "request_signal_passthrough",
        ],
        vars: {
          FORTIPI_ADMIN_TOKEN: bootstrap,
          FORTIPI_MODEL_AUTH_KEY: "a1".repeat(32),
          FORTIPI_CONFIG: config,
        },
        durable_objects: {
          bindings: [
            { name: "CONTROL_PLANE", class_name: "TestControlPlane" },
            { name: "WORKSPACES", class_name: "TestRecipient" },
            { name: "AGENT_SESSIONS", class_name: "TestRecipient" },
          ],
        },
        migrations: [{ tag: "v1", new_sqlite_classes: ["TestControlPlane", "TestRecipient"] }],
      }),
    );
    const start = async () => {
      const runtime = spawn(
        process.execPath,
        [
          resolve("apps/worker/node_modules/wrangler/bin/wrangler.js"),
          "dev",
          "--local",
          "--config",
          configPath,
          "--persist-to",
          join(directory, "state"),
          "--port",
          String(port),
          "--ip",
          "127.0.0.1",
          "--inspector-port",
          "0",
        ],
        {
          cwd: directory,
          detached: process.platform !== "win32",
          stdio: "ignore",
          env: {
            PATH: process.env.PATH ?? "",
            HOME: join(directory, "home"),
            TMPDIR: directory,
            XDG_CONFIG_HOME: join(directory, "config"),
            WRANGLER_SEND_METRICS: "false",
            CI: "true",
          },
        },
      );
      child = runtime;
      for (let i = 0; i < 200; i++) {
        try {
          if (
            (await fetch(`${base}/deployment`, { signal: AbortSignal.timeout(250) })).status === 200
          )
            return;
        } catch {}
        if (runtime.exitCode !== null) assert.fail("Managed Wrangler exited");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.fail("Managed Wrangler startup bound exceeded");
    };
    await start();
    const rpc = async <T>(method: string, body: unknown): Promise<T> => {
      const response = await fetch(`${base}/fixture/rpc/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 200);
      return response.json() as Promise<T>;
    };
    const deploymentId = (await (await fetch(`${base}/deployment`)).json()) as string;
    const auth = async (token = bootstrap) =>
      value(
        await rpc<D.Outcome<D.AuthContext>>("authenticate", {
          bearer: token,
          deploymentId,
          requestId: uuid(),
          deadline: Date.now() + 30000,
        }),
      );
    const mint = async (body: D.CredentialMint) => {
      const receipt = value(
        await rpc<D.Outcome<D.OperationResponse<"mintCredential">>>("mintCredential", {
          ctx: await auth(),
          input: request("mintCredential", body),
        }),
      );
      assert.equal(receipt.status, 201);
      if (receipt.status !== 201 || receipt.body.state !== "issued")
        assert.fail("Synthetic credential not issued");
      return receipt.body;
    };
    const resources = scope();
    const executor = await mint({
      requestId: uuid(),
      role: "executor",
      executorId: "executor",
      grants: [{ grantId: "executor", version: 1, resources }],
    });
    const connect = async () => {
      const minted = value(
        await rpc<D.Outcome<D.OperationResponse<"mintConnectionTicket">>>("mintTicket", {
          ctx: await auth(executor.token),
          input: request("mintConnectionTicket", {
            requestId: uuid(),
            audience: "executor-session",
            resources,
            originMode: { kind: "native" },
            executor: { executorId: "executor", generation: 1 },
          }),
        }),
      );
      if (minted.status !== 201) assert.fail("Synthetic executor ticket not minted");
      const frames: D.ExecutorFrame[] = [];
      const opened = new WebSocket(
        `${base.replace("http:", "ws:")}/v1/executor/session?ticket=${minted.body.ticket}`,
      );
      socket = opened;
      opened.addEventListener("message", (event) => frames.push(JSON.parse(String(event.data))));
      await new Promise<void>((resolve, reject) => {
        opened.addEventListener("open", () => resolve(), { once: true });
        opened.addEventListener(
          "error",
          () => reject(new Error("Synthetic executor connection failed")),
          { once: true },
        );
      });
      opened.send(
        JSON.stringify({
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
              chunkBytes: 65536,
              fileBytes: 1048576,
              snapshotBytes: 2097152,
              artifactBytes: 1048576,
              manifestEntries: 512,
            },
          },
        }),
      );
      for (let i = 0; i < 100; i++) {
        const registered = frames.find((frame) => frame.type === "executor.registered");
        if (registered?.type === "executor.registered") return registered.payload.connectionEpoch;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.fail("Executor did not register");
    };
    let epoch = await connect();
    await fetch(`${base}/fixture/transport/seed`);
    const owner = await mint({
      requestId: uuid(),
      role: "client",
      grants: [
        { grantId: "owner", version: 1, resources: scope(["jobs.dispatch", "workspace.write"]) },
      ],
    });
    const cp: Pick<ControlPlaneRpc, "reserveTarget" | "recordDispatchIntent" | "assignOnce"> = {
      reserveTarget: (ctx, input) => rpc("reserveTarget", { ctx, input }),
      recordDispatchIntent: (ctx, input) => rpc("recordDispatchIntent", { ctx, input }),
      assignOnce: (ctx, input) => rpc("assignOnce", { ctx, input }),
    };
    const job = await assignedJob({ cp, deploymentId }, await auth(owner.token));
    const manifest: D.Manifest = { version: 1, entries: [] };
    const body: D.UploadBegin = {
      requestId: uuid(),
      commitId: uuid(),
      operationId: job.reservation.operationId,
      baseRevision: job.identity.baseRevision,
      lease: job.identity.lease,
      manifest,
      manifestHash: await manifestDigest(manifest),
      mutations: [{ kind: "delete", path: "base.txt" }],
      blobs: [],
    };
    const call = (suffix: string, payload?: unknown, selectedEpoch = epoch) =>
      fetch(
        `${base}/v1/executor/jobs/${job.identity.jobId}/${suffix}?executionId=${job.identity.executionId}&assignmentDigest=${job.identity.assignmentDigest}&connectionEpoch=${selectedEpoch}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${executor.token}`,
            ...(payload === undefined ? {} : { "Content-Type": "application/json" }),
          },
          ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        },
      );
    const peer = (mode: string) =>
      fetch(`${base}/fixture/transport/peer`, { method: "POST", body: mode });
    const retained = async () =>
      (
        await fetch(`${base}/fixture/transport/retained?executionId=${job.identity.executionId}`)
      ).json() as Promise<{ assignment: D.Assignment; upload: { body: D.UploadBegin } }>;
    const peerState = async () =>
      (await peer("state")).json() as Promise<{ uploads: number; stages: string[] }>;
    await peer("dropBegin");
    assert.equal((await call("uploads", body)).status, 500);
    const before = await retained();
    assert.deepEqual(before.upload.body, body);
    assert.deepEqual(before.assignment, job.assignment);
    await stop();
    await start();
    epoch = await connect();
    assert.deepEqual(
      (await retained()).upload.body,
      body,
      "First intent survived actual process-tree SIGKILL",
    );
    assert.equal((await call("uploads", body, epoch - 1)).status, 401);
    assert.equal((await call("uploads", { ...body, commitId: uuid() })).status, 409);
    assert.equal((await call("uploads", body)).status, 201);
    assert.equal((await peerState()).uploads, 1);
    await peer("dropValidate");
    assert.equal((await call(`uploads/${body.requestId}/validate`)).status, 500);
    const expectedStage = (await peerState()).stages[0];
    assert.ok(expectedStage);
    await stop();
    await start();
    epoch = await connect();
    const sealed = await call(`uploads/${body.requestId}/validate`);
    assert.equal(sealed.status, 200);
    const stage = (await sealed.json()) as D.UploadValidation;
    assert.equal(
      stage.stageId,
      expectedStage,
      "Seal identity survived the lost reply and runtime-tree SIGKILL",
    );
    assert.deepEqual(await (await call(`uploads/${body.requestId}/validate`)).json(), stage);
    assert.deepEqual((await retained()).assignment, job.assignment);
    assert.equal((await peerState()).uploads, 1);
  } finally {
    socket?.close();
    await stop();
    await rm(directory, { recursive: true, force: true });
  }
});
