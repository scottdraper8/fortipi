import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ExecutionIdentity } from "../../packages/fortipi-contract/dist/executor.js";
import { freeInfrastructurePolicy } from "../../packages/fortipi-contract/dist/index.js";
import { Ledger } from "../../packages/fortipi-executor/dist/ledger.js";
import { Output } from "../../packages/fortipi-executor/dist/output.js";
import { childEnvironment } from "../../packages/fortipi-executor/dist/platform/types.js";
import { frame, HttpTransport, validate } from "../../packages/fortipi-executor/dist/transport.js";
import { assignment, fixture } from "../../packages/fortipi-executor/test/fixtures/daemon.ts";

export interface InfrastructureLocalOutputEdge {
  producedBytes: number;
  retainedBytes: number;
  tailBytes: number;
  artifactBytes: number;
  truncated: boolean;
}
export interface InfrastructureLocalOutput {
  limits: { outputBytesPerJob: number; inlineTailBytes: number; artifactBytes: number };
  below: InfrastructureLocalOutputEdge;
  at: InfrastructureLocalOutputEdge;
  above: InfrastructureLocalOutputEdge;
  bodyHashBefore: string;
  bodyHashAfterReopen: string;
}
export const infrastructureLocalOutputLimitations = [
  "LOCAL executor Output/transport-schema/SQLite/file component with lower configured capacities; no live account or Free ceiling proof",
  "Actual Node stdout; direct synthetic assignment/admission, without daemon approval/lease dispatch, remote transport authentication or remote artifact publication",
  "Graceful same-ledger reopen; no crash, separate host, installed-candidate or provider recovery claim",
] as const;

/** Capture actual finite stdout and send its real chunks through production Output. */
async function produce(output: Output, size: number, directory: string): Promise<Buffer> {
  const child = spawn(
    process.execPath,
    ["--input-type=module", "-e", `process.stdout.write(Buffer.alloc(${size}, 120));`],
    { cwd: directory, env: childEnvironment(), stdio: ["ignore", "pipe", "pipe"] },
  );
  const chunks: Buffer[] = [];
  let failure: unknown;
  let total = 0;
  const failed = (error: unknown) => {
    failure ??= error;
    child.kill("SIGKILL");
  };
  child.stdout.on("data", (value: Buffer) => {
    try {
      total += value.length;
      assert.ok(total <= size, "Native output exceeded the requested finite fixture");
      chunks.push(Buffer.from(value));
      output.append("stdout", value);
    } catch (error) {
      failed(error);
    }
  });
  child.stderr.on("data", () => failed(new Error("Unexpected local output child stderr")));
  const timer = setTimeout(() => failed(new Error("Local output child timeout")), 5000);
  try {
    const [code, signal] = await once(child, "close");
    if (failure) throw failure;
    assert.equal(signal, null);
    assert.equal(code, 0);
    assert.equal(total, size);
    output.finish();
    return Buffer.concat(chunks, total);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}

async function observe(ledger: Ledger, identity: ExecutionIdentity) {
  const row = ledger.existing(identity);
  assert.ok(row?.result, "Persisted local output result missing");
  const deliveries = ledger.outbox().filter((value) => {
    frame(value);
    return value.type === "job.output" && value.payload.identity.jobId === identity.jobId;
  });
  const retained = Buffer.concat(
    deliveries.map((value) => {
      assert.equal(value.type, "job.output");
      if (value.type !== "job.output") throw new Error("Unexpected local output delivery");
      assert.deepEqual(value.payload.identity, identity);
      return Buffer.from(value.payload.text);
    }),
  );
  assert.equal(row.outputBytes, retained.length);
  let artifactBytes = 0;
  for (const artifact of row.result.output.artifacts) {
    assert.equal(artifact.outputSource?.stream, "stdout");
    assert.ok(artifact.artifactId, "Local output artifact ID missing");
    const bytes = await readFile(join(dirname(ledger.path), "artifacts", artifact.artifactId));
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      artifact.sha256,
      "Local output artifact identity changed",
    );
    assert.equal(bytes.length, artifact.size);
    assert.deepEqual(bytes, retained.subarray(0, bytes.length));
    artifactBytes += bytes.length;
  }
  return {
    retained,
    tail: row.result.output.tail,
    artifactBytes,
    truncated: row.result.output.truncated,
    bodyHash: row.bodyHash,
    deliveries,
  };
}

/** Produces only the closed LOCAL detail.output data. No Gate or authority is created. */
export async function runInfrastructureLocalOutput(): Promise<InfrastructureLocalOutput> {
  const f = await fixture();
  let ledger: Ledger | undefined;
  try {
    const allocation = { outputBytesPerJob: 256, inlineTailBytes: 32, artifactBytes: 256 };
    validate("infrastructure.schema.json", "InfrastructurePolicy", {
      ...freeInfrastructurePolicy,
      bounds: { ...freeInfrastructurePolicy.bounds, ...allocation },
    });
    f.profile.limits = allocation;
    const transport = new HttpTransport(f.profile, fetch, true);
    const { outputBytesPerJob, inlineTailBytes, artifactBytes } = transport.limits;
    const limits = { outputBytesPerJob, inlineTailBytes, artifactBytes };
    const directory = join(f.directory, "output-ledger");
    const ledgerId = randomUUID();
    ledger = await Ledger.provision(directory, ledgerId, transport.limits);
    const observations: InfrastructureLocalOutputEdge[] = [];
    const originals = [];
    for (const size of [outputBytesPerJob - 1, outputBytesPerJob, outputBytesPerJob + 1]) {
      const a = await assignment("LOCAL output component; no daemon dispatch");
      const admitted = ledger.admit(a, "LOCAL synthetic admission");
      const output = new Output(ledger, a.identity, transport.limits, transport.outputFrameBytes);
      const produced = await produce(output, size, directory);
      const result = await output.result("succeeded", join(directory, "artifacts"), false);
      const prepared = frame({
        type: "job.prepared_result",
        requestId: randomUUID(),
        payload: result,
      });
      ledger.transaction(() => {
        assert.ok(ledger);
        const row = ledger.existing(a.identity);
        assert.ok(row);
        row.result = result;
        row.sequence = result.sequence;
        row.state = "result";
        ledger.put(row);
        ledger.enqueue(a.identity.jobId, "result", result.sequence, prepared);
      });
      const observed = await observe(ledger, a.identity);
      assert.equal(observed.bodyHash, admitted.bodyHash);
      assert.deepEqual(observed.retained, produced.subarray(0, observed.retained.length));
      assert.equal(observed.tail, observed.retained.subarray(-inlineTailBytes).toString("utf8"));
      observations.push({
        producedBytes: produced.length,
        retainedBytes: observed.retained.length,
        tailBytes: Buffer.byteLength(observed.tail),
        artifactBytes: observed.artifactBytes,
        truncated: observed.truncated,
      });
      originals.push({ identity: a.identity, bodyHashBefore: admitted.bodyHash, observed });
    }
    const above = originals[2];
    assert.ok(above);
    const bodyHashBefore = above.bodyHashBefore;
    ledger.close();
    ledger = undefined;
    ledger = await Ledger.open(directory, ledgerId, transport.limits);
    for (const original of originals)
      assert.deepEqual(await observe(ledger, original.identity), original.observed);
    const bodyHashAfterReopen = ledger.existing(above.identity)?.bodyHash;
    assert.ok(bodyHashAfterReopen);
    const [below, at, over] = observations;
    assert.ok(below && at && over);
    return { limits, below, at, above: over, bodyHashBefore, bodyHashAfterReopen };
  } finally {
    try {
      ledger?.close();
    } finally {
      await f.cleanup();
    }
  }
}
