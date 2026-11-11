import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import test from "node:test";
import type * as D from "../../src/boundary/dto.js";
import { assignedJob } from "./artifact-job.ts";
import { bootstrap, config, request, scope, uuid, value } from "./harness.ts";

test("artifact index and interrupted producer correlation survive actual Wrangler/workerd SIGKILL and reopen", {
  timeout: 30000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "fortipi-artifact-reopen-"));
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  const base = `http://127.0.0.1:${port}`;
  const configPath = join(directory, "wrangler.json");
  let child: ChildProcess | undefined;
  let socket: WebSocket | undefined;
  const kill = async () => {
    if (!child || child.exitCode !== null) return;
    const runtime = child;
    const exited = new Promise<void>((resolve) => runtime.once("exit", () => resolve()));
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/PID", String(runtime.pid), "/T", "/F"], {
        stdio: "ignore",
      });
      await new Promise<void>((resolve) => killer.once("exit", () => resolve()));
    } else if (runtime.pid) process.kill(-runtime.pid, "SIGKILL");
    await exited;
    child = undefined;
  };
  try {
    await writeFile(
      configPath,
      JSON.stringify({
        name: "control-artifact-reopen",
        main: resolve("apps/worker/test/control/fixtures/artifacts.ts"),
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
      child = spawn(
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
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            PATH: process.env.PATH ?? "",
            TMPDIR: directory,
            XDG_CONFIG_HOME: join(directory, "config"),
            WRANGLER_SEND_METRICS: "false",
            CI: "true",
          },
        },
      );
      child.stdout?.resume();
      child.stderr?.resume();
      for (let n = 0; n < 150; n++) {
        try {
          const response = await fetch(`${base}/deployment`);
          if (response.ok) return;
        } catch {}
        assert.equal(child.exitCode, null, "actual runtime must start");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.fail("Runtime startup deadline");
    };
    await start();
    const rpc = async <T>(name: string, body: unknown): Promise<T> => {
      const response = await fetch(`${base}/fixture/rpc/${name}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 200);
      return (await response.json()) as T;
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
    const admin = await auth();
    const minted = value(
      await rpc<D.Outcome<D.OperationResponse<"mintCredential">>>("mintCredential", {
        ctx: admin,
        input: request("mintCredential", {
          requestId: uuid(),
          role: "executor",
          executorId: "executor",
          grants: [{ grantId: uuid(), version: 1, resources: scope() }],
        }),
      }),
    );
    assert.equal(minted.status, 201);
    assert.equal(minted.body.state, "issued");
    if (minted.body.state !== "issued") assert.fail("Missing synthetic executor");
    const token = minted.body.token;
    const connect = async () => {
      const executor = await auth(token);
      const ticket = value(
        await rpc<D.Outcome<D.OperationResponse<"mintConnectionTicket">>>("mintTicket", {
          ctx: executor,
          input: request("mintConnectionTicket", {
            requestId: uuid(),
            audience: "executor-session",
            originMode: { kind: "native" },
            resources: scope(),
            executor: { executorId: "executor", generation: 1 },
          }),
        }),
      );
      assert.equal(ticket.status, 201);
      const live = new WebSocket(
        `${base.replace("http:", "ws:")}/v1/executor/session?ticket=${ticket.body.ticket}`,
      );
      socket = live;
      const frames: D.ExecutorFrame[] = [];
      live.addEventListener("message", (event) =>
        frames.push(JSON.parse(String(event.data)) as D.ExecutorFrame),
      );
      await new Promise<void>((resolve, reject) => {
        live.addEventListener("open", () => resolve(), { once: true });
        live.addEventListener("error", () => reject(new Error("Socket unavailable")), {
          once: true,
        });
      });
      const wait = async (type: D.ExecutorFrame["type"]) => {
        for (let n = 0; n < 150; n++) {
          const frame = frames.find((frame) => frame.type === type);
          if (frame) return frame;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.fail(`Missing ${type}`);
      };
      live.send(
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
              fileBytes: 4194304,
              snapshotBytes: 16777216,
              artifactBytes: 1048576,
              manifestEntries: 512,
            },
          },
        } satisfies D.ExecutorFrame),
      );
      await wait("executor.registered");
      return { live, wait, frames };
    };
    let connection = await connect();
    const cp = {
      reserveTarget: (ctx: D.AuthContext, input: D.TargetRequest) =>
        rpc<D.Outcome<D.TargetReservation>>("reserveTarget", { ctx, input }),
      recordDispatchIntent: (ctx: D.AuthContext, input: D.DispatchIntent) =>
        rpc<D.Outcome<D.DispatchReceipt>>("recordDispatchIntent", { ctx, input }),
      assignOnce: (ctx: D.AuthContext, input: D.Assignment) =>
        rpc<D.Outcome<D.DispatchAck>>("assignOnce", { ctx, input }),
    };
    const job = await assignedJob({ deploymentId, cp }, admin);
    const privatePath = join(directory, "owner-private-empty.bin");
    await writeFile(privatePath, new Uint8Array());
    const sha256 = createHash("sha256")
      .update(await readFile(privatePath))
      .digest("hex");
    const artifactId = uuid();
    const result: D.PreparedResult = {
      identity: job.identity,
      sequence: 1,
      state: "succeeded",
      possibleExternalEffects: false,
      output: {
        tail: "",
        truncated: false,
        artifacts: [
          {
            artifactId,
            workspaceId: "workspace",
            revision: job.identity.baseRevision,
            endpoint: `/v1/workspaces/workspace/artifacts/${artifactId}`,
            sha256,
            size: 0,
            owner: { kind: "local", executorId: "executor" },
            chunks: { chunkBytes: 65536, chunkHashes: [] },
            outputSource: { stream: "stdout" },
          },
        ],
      },
    };
    connection.live.send(
      JSON.stringify({
        type: "job.prepared_result",
        requestId: uuid(),
        payload: result,
      } satisfies D.ExecutorFrame),
    );
    await connection.wait("job.result_ack");
    const record = await (await fetch(`${base}/fixture/record/${artifactId}`)).json();
    assert.ok(record);
    await rpc("drain", {});
    const registration = value(
      await rpc<D.Outcome<D.AuthorityRegistration>>("registerAuthorityRecipient", {
        ctx: admin,
        input: {
          credential: {
            credentialId: admin.credentialId,
            generation: admin.generation,
            grantVersion: admin.grantVersion,
          },
          recipient: { kind: "workspace", id: "workspace" },
          resources: {
            agentIds: [],
            conversationIds: [],
            workspaceIds: ["workspace"],
            executorIds: [],
            backendIds: [],
            tools: [],
            actions: ["artifacts.read"],
          },
        },
      }),
    );
    const reader = { ...admin, registrationId: registration.registrationId };
    const pending = fetch(`${base}/internal/artifacts/workspace/${artifactId}`, {
      headers: { "X-Fortipi-Context": JSON.stringify(reader) },
    }).catch(() => undefined);
    const open = await connection.wait("transfer.open");
    assert.equal(open.type, "transfer.open");
    if (open.type !== "transfer.open") assert.fail("Missing actual producer open");
    const old = open.payload;
    await kill();
    await pending;
    await start();
    assert.equal(
      await (await fetch(`${base}/fixture/record/${artifactId}`)).json(),
      record,
      "exact acknowledged index survives process-tree SIGKILL after inbox acknowledgment",
    );
    const observed = value(
      await rpc<D.Outcome<D.TransferStatus>>("observeTransfer", {
        ctx: await auth(),
        input: { transferId: old.transferId, attemptId: old.attemptId },
      }),
    );
    assert.equal(
      observed.state,
      "interrupted",
      "old producer correlation cannot become verified on restart",
    );
    connection = await connect();
    const freshReader = { ...(await auth()), registrationId: registration.registrationId };
    const fresh = fetch(
      `${base}/internal/artifacts/workspace/${artifactId}?revision=${job.identity.baseRevision}`,
      { headers: { "X-Fortipi-Context": JSON.stringify(freshReader) } },
    );
    const newOpen = await connection.wait("transfer.open");
    if (newOpen.type !== "transfer.open") assert.fail("Missing fresh open");
    assert.notEqual(newOpen.payload.attemptId, old.attemptId);
    const actual = await readFile(privatePath);
    assert.equal(actual.length, 0);
    assert.equal(createHash("sha256").update(actual).digest("hex"), newOpen.payload.fileSha256);
    assert.deepEqual(newOpen.payload.chunkHashes, []);
    assert.deepEqual(newOpen.payload.content, { kind: "job-output", artifactId, stream: "stdout" });
    connection.live.send(
      JSON.stringify({
        type: "transfer.status",
        requestId: newOpen.requestId,
        payload: {
          transferId: newOpen.payload.transferId,
          attemptId: newOpen.payload.attemptId,
          state: "verified",
          verifiedChunks: [],
          bytes: 0,
        },
      } satisfies D.ExecutorFrame),
    );
    const response = await fresh;
    assert.equal(response.status, 200);
    assert.equal((await response.arrayBuffer()).byteLength, 0);
    assert.equal(
      connection.frames.filter((frame) => frame.type === "job.assign").length,
      0,
      "reopen and retained reads cannot replay execution",
    );
  } finally {
    socket?.close();
    await kill();
    await rm(directory, { recursive: true, force: true });
  }
});
