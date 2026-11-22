import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { manifestDigest } from "fortipi-contract";
import type * as D from "../../src/boundary/dto.js";
import { assignedJob } from "./artifact-job.ts";
import { connected } from "./connection.ts";
import type { TransportControl } from "./fixtures/executor-workspace.js";
import { harness, request, scope, uuid, value } from "./harness.ts";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const baseBytes = new Uint8Array(587661).fill(31);
async function setup(options: { leaseMs?: number } = {}) {
  const h = await harness<TransportControl>({
    fixturePath: "apps/worker/test/control/fixtures/executor-workspace.ts",
    allowedOrigins: ["https://client.fixture"],
  });
  let channel: Awaited<ReturnType<typeof connected>> | undefined;
  try {
    channel = await connected(h);
    await h.cp.seedTransportBinding();
    const issued = await h.mint({
      requestId: uuid(),
      role: "client",
      grants: [
        {
          grantId: "job_owner",
          version: 1,
          resources: scope(["jobs.dispatch", "workspace.write"]),
        },
      ],
    });
    const actor = await h.auth(issued.token);
    const job = await assignedJob(h, actor, {
      ...(options.leaseMs ? { leaseExpiresAt: Date.now() + options.leaseMs } : {}),
    });
    const { url } = await h.server.listen();
    const raw = (path: string, init: RequestInit = {}, token = channel?.issued.token ?? "") =>
      fetch(new URL(path, url), {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Fortipi-Context": "spoofed",
          "x-fortipi-workspace-context": "spoofed",
          ...init.headers,
        },
      });
    const path = (suffix: string, identity = job.identity, epoch = channel?.epoch ?? 0) =>
      `/v1/executor/jobs/${identity.jobId}/${suffix}${suffix.includes("?") ? "&" : "?"}executionId=${identity.executionId}&assignmentDigest=${identity.assignmentDigest}&connectionEpoch=${epoch}`;
    const call = (suffix: string, init: RequestInit = {}, token?: string) =>
      raw(path(suffix), init, token);
    const peer = async (mode = "state") =>
      JSON.parse(await h.cp.transportPeer(mode)) as {
        entered: boolean;
        held: number;
        versions: number;
        calls: Record<string, number>;
        uploads: number;
        cancelled: number;
        actor?: D.AuthContext;
      };
    return {
      ...h,
      actor,
      issued,
      job,
      channel,
      raw,
      path,
      call,
      peer,
      async close() {
        channel?.socket.close();
        await h.close();
      },
    };
  } catch (error) {
    channel?.socket.close();
    await h.close();
    throw error;
  }
}
async function beginBody(
  h: Awaited<ReturnType<typeof setup>>,
  bytes = new Uint8Array([7, 8, 9]),
): Promise<D.UploadBegin> {
  const manifest: D.Manifest = {
    version: 1,
    entries: [
      { path: "result.txt", type: "file", mode: 420, size: bytes.length, sha256: sha(bytes) },
    ],
  };
  return {
    requestId: uuid(),
    baseRevision: h.job.identity.baseRevision,
    lease: h.job.identity.lease,
    operationId: h.job.reservation.operationId,
    commitId: uuid(),
    manifestHash: await manifestDigest(manifest),
    manifest,
    mutations: [
      { kind: "delete", path: "base.txt" },
      { kind: "put", path: "result.txt", mode: 420, size: bytes.length, sha256: sha(bytes) },
    ],
    blobs: [{ sha256: sha(bytes), chunks: { chunkBytes: 65536, chunkHashes: [sha(bytes)] } }],
  };
}
const post = (body?: unknown): RequestInit => ({
  method: "POST",
  ...(body === undefined
    ? {}
    : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
});
async function entered(h: Awaited<ReturnType<typeof setup>>) {
  for (let i = 0; i < 100; i++) {
    if ((await h.peer()).entered) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Controlled namespace peer was not entered");
}

test("executor job HTTP resolves original write-only owner, streams exact base and stages one immutable upload through lost replies", {
  timeout: 30000,
}, async () => {
  const h = await setup();
  try {
    const manifest = await h.call("manifest");
    assert.equal(manifest.status, 200, await manifest.clone().text());
    const metadata = (await manifest.json()) as D.ManifestResponse;
    assert.equal(metadata.manifestHash, await manifestDigest(metadata.manifest));
    assert.equal(metadata.revision, h.job.identity.baseRevision);
    const response = await h.call(`blobs/${sha(baseBytes)}`, {
      headers: { Cookie: "spoofed", "X-Fortipi-Socket": "spoofed" },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Content-Length"), String(baseBytes.length));
    assert.equal(response.headers.get("X-Content-SHA256"), sha(baseBytes));
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), baseBytes);
    assert.equal(response.headers.get("x-fortipi-workspace-context"), null);
    const audit = await h.peer();
    assert.equal(audit.actor?.role, "client");
    assert.equal(audit.actor?.credentialId, h.issued.credential.credentialId);
    assert.equal(audit.actor?.registrationId, h.job.reservation.registrationIds.workspace);
    assert.deepEqual(audit.actor?.grants[0]?.resources.actions, [
      "jobs.dispatch",
      "workspace.write",
    ]);
    const bytes = new Uint8Array([7, 8, 9]),
      body = await beginBody(h, bytes);
    await h.peer("dropBegin");
    assert.equal((await h.call("uploads", post(body))).status, 500);
    const retained = JSON.parse(await h.cp.transportRetained(h.job.identity.executionId));
    assert.ok(
      retained.upload,
      "Persist-before-RPC upload association survives a lost accepted reply",
    );
    assert.deepEqual(retained.assignment, h.job.assignment);
    assert.deepEqual(
      retained.upload.body,
      body,
      "Upload association survives a lost accepted reply",
    );
    const opened = await h.call("uploads", post(body));
    assert.equal(opened.status, 201);
    assert.equal(((await opened.json()) as D.UploadStatus).uploadId, body.requestId);
    assert.equal((await h.call("uploads", post({ ...body, commitId: uuid() }))).status, 409);
    assert.equal((await h.peer()).uploads, 1);
    const chunk = `uploads/${body.requestId}/blobs/${sha(bytes)}/chunks/0?length=3&sha256=${sha(bytes)}`;
    assert.equal((await h.call(chunk, { method: "PUT", body: bytes })).status, 204);
    await h.peer("dropValidate");
    assert.equal((await h.call(`uploads/${body.requestId}/validate`, post())).status, 500);
    const sealed = await h.call(`uploads/${body.requestId}/validate`, post());
    assert.equal(sealed.status, 200);
    const stage = (await sealed.json()) as D.UploadValidation;
    assert.deepEqual(
      await (await h.call(`uploads/${body.requestId}/validate`, post())).json(),
      stage,
    );
    assert.equal((await h.peer()).calls.commit ?? 0, 0);
  } finally {
    await h.close();
  }
});

test("executor workspace closed selectors and paired role/epoch reject forged queries and cross-execution uploads", {
  timeout: 30000,
}, async () => {
  const h = await setup();
  try {
    const valid = h.path("manifest");
    for (const path of [
      `${valid}&revision=other`,
      `${valid}&executionId=other`,
      valid.replace(/connectionEpoch=\d+/, "connectionEpoch=0"),
      valid.replace(/connectionEpoch=\d+/, "connectionEpoch=1e0"),
      valid.replace(/connectionEpoch=\d+/, `connectionEpoch=${h.channel.epoch + 1}`),
      valid.replace(h.job.identity.assignmentDigest, "0".repeat(64)),
      valid.replace(h.job.identity.executionId, "missing_execution"),
      valid.replace(h.job.identity.jobId, "other_job"),
    ])
      assert.ok((await h.raw(path)).status >= 400, path);
    assert.equal((await h.call("manifest", {}, h.issued.token)).status, 403);
    assert.equal(
      (await h.call("manifest", { headers: { Origin: "https://wrong.fixture" } })).status,
      403,
    );
    const cors = await h.call("manifest", { headers: { Origin: "https://client.fixture" } });
    assert.equal(cors.status, 200);
    assert.equal(cors.headers.get("Access-Control-Allow-Origin"), "https://client.fixture");
    assert.equal((await h.call("manifest", post())).status, 400);
    assert.equal(
      (await h.call(`blobs/${sha(baseBytes)}`, { headers: { Range: "bytes=0-2" } })).status,
      400,
    );
    const body = await beginBody(h);
    assert.equal((await h.call("uploads", post({ ...body, baseRevision: "other" }))).status, 409);
    assert.equal(
      (await h.call("uploads", post({ ...body, lease: { ...body.lease, fence: "2" } }))).status,
      409,
    );
    assert.equal((await h.call("uploads", post(body))).status, 201);
    const other = await assignedJob(h, { ...h.actor, deadline: Date.now() + 30000 });
    assert.equal(
      (await h.raw(h.path(`uploads/${body.requestId}/validate`, other.identity), post())).status,
      403,
    );
    assert.equal((await h.peer()).calls.validate ?? 0, 0);
  } finally {
    await h.close();
  }
});

test("assigned workspace requires one current full owner grant, retained registration, live binding/fence and nonterminal authority", {
  timeout: 60000,
}, async () => {
  for (const kind of [
    "split",
    "grant",
    "registration",
    "binding",
    "lease",
    "cancel",
    "terminal",
  ] as const) {
    const h = await setup();
    try {
      assert.equal((await h.call("manifest")).status, 200);
      await h.cp.transportFault(h.job.identity.executionId, kind);
      assert.ok((await h.call("manifest")).status >= 400, kind);
      assert.equal((await h.peer()).calls.snapshot, 1, `${kind} rejected before peer bytes`);
    } finally {
      await h.close();
    }
  }
});

test("upload admission rechecks owner revocation, reconnect epoch and current renewal after awaited peer effects", {
  timeout: 60000,
}, async () => {
  for (const kind of ["revoked", "epoch", "blob"] as const) {
    const h = await setup();
    let replacement: Awaited<ReturnType<typeof connected>> | undefined;
    try {
      const body = await beginBody(h);
      await h.peer(kind === "blob" ? "holdSnapshot" : "holdBegin");
      const pending =
        kind === "blob" ? h.call(`blobs/${sha(baseBytes)}`) : h.call("uploads", post(body));
      await entered(h);
      if (kind !== "epoch")
        value(
          await h.cp.revokeCredential(
            await h.auth(),
            request(
              "revokeCredential",
              { requestId: uuid(), expectedGeneration: 1 },
              { id: h.issued.credential.credentialId },
            ),
          ),
        );
      else replacement = await connected(h);
      await h.peer("release");
      assert.ok((await pending).status >= 400, kind);
      if (kind === "blob") {
        for (let i = 0; i < 80 && !(await h.peer()).cancelled; i++)
          await new Promise((resolve) => setTimeout(resolve, 10));
        assert.ok(
          (await h.peer()).cancelled > 0,
          "Rejected awaited blob headers must cancel the actual upstream reader",
        );
      } else
        assert.equal(
          JSON.parse(await h.cp.transportRetained(h.job.identity.executionId)).upload.status,
          undefined,
          "No successful receipt after authority changed",
        );
    } finally {
      replacement?.socket.close();
      await h.close();
    }
  }
  const h = await setup({ leaseMs: 1400 });
  try {
    const body = await beginBody(h);
    await h.cp.transportFault(h.job.identity.executionId, "renew");
    body.lease = JSON.parse(await h.cp.transportRetained(h.job.identity.executionId)).lease;
    await h.peer("dropBegin");
    assert.equal((await h.call("uploads", post(body))).status, 500);
    await h.cp.transportFault(h.job.identity.executionId, "renew");
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(1, h.job.identity.lease.expiresAt - Date.now() + 20)),
    );
    assert.equal(
      (await h.call("uploads", post(body))).status,
      201,
      "Pinned intermediate-renewal body must recover under the current live lease",
    );
    assert.deepEqual(
      JSON.parse(await h.cp.transportRetained(h.job.identity.executionId)).assignment,
      h.job.assignment,
    );
  } finally {
    await h.close();
  }
});

test("assigned base byte delivery enforces whole SHA, length and consumer cancellation", {
  timeout: 30000,
}, async () => {
  const h = await setup();
  try {
    for (const mode of ["corrupt", "truncated"]) {
      await h.peer(mode);
      const response = await h.call(`blobs/${sha(baseBytes)}`);
      assert.equal(response.status, 200);
      await assert.rejects(response.arrayBuffer(), mode);
    }
    await h.peer("empty");
    const empty = await h.call(`blobs/${sha(new Uint8Array())}`);
    assert.equal(empty.status, 200);
    assert.equal(empty.headers.get("Content-Length"), "0");
    assert.equal((await empty.arrayBuffer()).byteLength, 0);
    await h.peer("badzero");
    assert.equal(
      (await h.call(`blobs/${"0".repeat(64)}`)).status,
      409,
      "Zero length cannot bypass actual whole-SHA identity",
    );
    await h.peer("slow");
    const cancelledBefore = (await h.peer()).cancelled;
    const controller = new AbortController();
    const response = await h.call(`blobs/${sha(baseBytes)}`, { signal: controller.signal });
    assert.equal(response.status, 200);
    const reader = response.body?.getReader();
    assert.ok(reader);
    assert.equal((await reader.read()).done, false);
    controller.abort();
    await reader.cancel().catch(() => {});
    for (let i = 0; i < 50 && (await h.peer()).cancelled === cancelledBefore; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok((await h.peer()).cancelled > cancelledBefore);
  } finally {
    await h.close();
  }
});

test("assigned byte stream rejects a blocked read after current owner revocation", {
  timeout: 30000,
}, async () => {
  const h = await setup();
  try {
    await h.peer("holdStream");
    const response = await h.call(`blobs/${sha(baseBytes)}`);
    assert.equal(response.status, 200);
    const reader = response.body?.getReader();
    assert.ok(reader);
    const first = await reader.read();
    assert.equal(first.done, false);
    let beforeRevocation = first.value?.length ?? 0;
    while (beforeRevocation < 32768) {
      const part = await reader.read();
      assert.equal(part.done, false);
      beforeRevocation += part.value?.length ?? 0;
    }
    assert.equal(
      beforeRevocation,
      32768,
      "Drain the first authorized producer block before changing the floor",
    );
    await entered(h);
    value(
      await h.cp.revokeCredential(
        await h.auth(),
        request(
          "revokeCredential",
          { requestId: uuid(), expectedGeneration: 1 },
          { id: h.issued.credential.credentialId },
        ),
      ),
    );
    await h.peer("release");
    let accepted = 0;
    await assert.rejects(async () => {
      for (;;) {
        const next = await reader.read();
        if (next.done) return;
        accepted += next.value.length;
      }
    });
    assert.equal(accepted, 0, "No blocked bytes accepted after the credential floor changed");
  } finally {
    await h.close();
  }
});

test("assigned transfer slots retire on effect deadline and revoked owner without granting a replacement old authority", {
  timeout: 30000,
}, async () => {
  for (const mode of ["deadline", "revocation"] as const) {
    const h = await setup(mode === "deadline" ? { leaseMs: 1500 } : {});
    const aborters: AbortController[] = [];
    const responses: Response[] = [];
    try {
      const issued = await h.mint({
        requestId: uuid(),
        role: "client",
        grants: [
          {
            grantId: "another_current_owner",
            version: 1,
            resources: scope(["jobs.dispatch", "workspace.write"]),
          },
        ],
      });
      const next = await assignedJob(h, await h.auth(issued.token));
      if (mode === "deadline") {
        const body = await beginBody(h);
        assert.equal((await h.call("uploads", post(body))).status, 201);
        const bytes = new Uint8Array([7, 8, 9]);
        const chunk = `uploads/${body.requestId}/blobs/${sha(bytes)}/chunks/0?length=3&sha256=${sha(bytes)}`;
        const pending: Promise<Response>[] = [];
        const before = (await h.peer()).versions;
        for (let i = 0; i < 4; i++) {
          const controller = new AbortController();
          aborters.push(controller);
          const init: RequestInit & { duplex: "half" } = {
            method: "PUT",
            body: new ReadableStream({
              start(writer) {
                writer.enqueue(bytes.subarray(0, 1));
              },
            }),
            signal: controller.signal,
            duplex: "half",
          };
          pending.push(h.call(chunk, init));
        }
        for (let i = 0; i < 100 && (await h.peer()).versions < before + 4; i++)
          await new Promise((resolve) => setTimeout(resolve, 10));
        assert.equal((await h.peer()).versions, before + 4);
        for (const response of await Promise.all(pending)) {
          responses.push(response);
          assert.ok(
            response.status >= 400,
            "A held body cannot complete beyond its admitted effect deadline",
          );
        }
        assert.equal(
          (await h.peer()).calls.chunk ?? 0,
          0,
          "Expired partial bodies cannot reach Workspace.putChunk",
        );
      } else {
        await h.peer("holdStream");
        for (let i = 0; i < 4; i++) {
          const controller = new AbortController();
          aborters.push(controller);
          const response = await h.call(`blobs/${sha(baseBytes)}`, { signal: controller.signal });
          assert.equal(response.status, 200);
          responses.push(response);
        }
        for (let i = 0; i < 100 && (await h.peer()).held < 4; i++)
          await new Promise((resolve) => setTimeout(resolve, 10));
        assert.equal((await h.peer()).held, 4);
        value(
          await h.cp.revokeCredential(
            await h.auth(),
            request(
              "revokeCredential",
              { requestId: uuid(), expectedGeneration: 1 },
              { id: h.issued.credential.credentialId },
            ),
          ),
        );
      }
      const accepted = await h.raw(h.path("manifest", next.identity));
      assert.equal(
        accepted.status,
        200,
        `${mode} retired all four old slots for an independently authorized execution`,
      );
      assert.ok(
        (await h.call("manifest")).status >= 400,
        "A different live job never revives the old authority",
      );
      if (mode === "revocation") {
        for (let i = 0; i < 100 && (await h.peer()).cancelled < 4; i++)
          await new Promise((resolve) => setTimeout(resolve, 10));
        assert.equal(
          (await h.peer()).cancelled,
          4,
          "Reclaiming revoked slots cancels all actual upstream readers",
        );
        for (const response of responses) await assert.rejects(response.arrayBuffer());
      }
    } finally {
      for (const controller of aborters) controller.abort();
      await h.peer("release").catch(() => {});
      await Promise.all(responses.map((response) => response.body?.cancel().catch(() => {})));
      await h.close();
    }
  }
});

test("configured four assigned transfers refuse the fifth held blob and slow upload body and reclaim completed slots", {
  timeout: 30000,
}, async () => {
  const h = await setup();
  const aborters: AbortController[] = [];
  const responses: Response[] = [];
  try {
    await h.peer("holdStream");
    for (let i = 0; i < 4; i++) {
      const controller = new AbortController();
      aborters.push(controller);
      const response = await h.call(`blobs/${sha(baseBytes)}`, { signal: controller.signal });
      assert.equal(response.status, 200);
      responses.push(response);
    }
    for (let i = 0; i < 100 && (await h.peer()).held < 4; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(
      (await h.peer()).held,
      4,
      "Four actual producer reads remain simultaneously blocked",
    );
    assert.equal(
      (await h.raw(h.path("manifest", h.job.identity, h.channel.epoch + 1))).status,
      401,
      "Uncurrent authority cannot claim a full-pool slot",
    );
    const fifth = new AbortController();
    aborters.push(fifth);
    const refused = await h.call(`blobs/${sha(baseBytes)}`, { signal: fifth.signal });
    responses.push(refused);
    assert.equal(
      refused.status,
      429,
      "Fifth assigned blob stream must be refused while four are held",
    );
    const error = (await refused.json()) as D.ErrorBody;
    assert.equal(error.error.code, "quota_exceeded");
    assert.equal(error.error.details?.pressure?.resource, "concurrency");
    for (const controller of aborters) controller.abort();
    await h.peer("release");
    await Promise.all(responses.map((response) => response.body?.cancel().catch(() => {})));
    await h.peer("valid");
    for (let i = 0; i < 100 && (await h.peer()).held; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    const opened = await h.call("manifest");
    assert.equal(opened.status, 200, "Cancelled streams release their slots");

    const bytes = new Uint8Array([7, 8, 9]),
      body = await beginBody(h, bytes);
    assert.equal((await h.call("uploads", post(body))).status, 201);
    const chunk = `uploads/${body.requestId}/blobs/${sha(bytes)}/chunks/0?length=3&sha256=${sha(bytes)}`;
    const versionFloor = (await h.peer()).versions;
    const writers: ReadableStreamDefaultController<Uint8Array>[] = [];
    const pending: Promise<Response>[] = [];
    for (let i = 0; i < 4; i++) {
      const controller = new AbortController();
      aborters.push(controller);
      const stream = new ReadableStream<Uint8Array>({
        start(writer) {
          writers.push(writer);
          writer.enqueue(bytes.subarray(0, 1));
        },
      });
      const init: RequestInit & { duplex: "half" } = {
        method: "PUT",
        body: stream,
        signal: controller.signal,
        duplex: "half",
      };
      pending.push(h.call(chunk, init));
    }
    for (let i = 0; i < 100 && (await h.peer()).versions < versionFloor + 4; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(
      (await h.peer()).versions,
      versionFloor + 4,
      "Four authorized HTTP requests reached the peer and remain waiting for body bytes",
    );
    assert.equal(
      (await h.call(chunk, { method: "PUT", body: bytes })).status,
      429,
      "Fifth slow upload body must not allocate another manager slot",
    );
    writers[0]?.enqueue(bytes.subarray(1));
    writers[0]?.close();
    assert.equal((await pending[0])?.status, 204);
    assert.equal(
      (await h.call(chunk, { method: "PUT", body: bytes })).status,
      204,
      "An actual completed upload returns its slot",
    );
    for (const writer of writers.slice(1)) {
      writer.enqueue(bytes.subarray(1));
      writer.close();
    }
    for (const response of await Promise.all(pending)) assert.equal(response.status, 204);
    for (let i = 0; i < 4; i++) {
      const after = await h.call(`blobs/${sha(baseBytes)}`);
      assert.equal(after.status, 200);
      assert.equal(
        (await after.arrayBuffer()).byteLength,
        baseBytes.length,
        "Full EOF releases byte-stream ownership",
      );
    }
    assert.equal(
      (await h.call("manifest")).status,
      200,
      "Four successful EOFs cannot leak all four slots",
    );
  } finally {
    for (const controller of aborters) controller.abort();
    await h.peer("release").catch(() => {});
    await Promise.all(responses.map((response) => response.body?.cancel().catch(() => {})));
    await h.close();
  }
});
