import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type * as D from "../../src/boundary/dto.js";

export interface ProcessArm {
  runId: string;
  agentId: string;
  point: "before-submit" | "after-submit";
  armId: string;
  generation: string;
}
export interface ProcessWitness extends ProcessArm {
  admissions: {
    operationId: string;
    messageId: string;
    taskId: string;
    receipt: D.AdmissionReceipt | null;
  }[];
}

type ProcessApi = <T>(path: string, body?: unknown) => Promise<{ status: number; body: T }>;
const generationMatches = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9-]{36}$/.test(value);

/** A private scheduling cue, never evidence that its transaction committed. */
export function processCueMatches(line: string, arm: ProcessArm): boolean {
  const prefix = "FORTIPI_PROCESS_CUE ";
  if (line.length > 512 || !line.startsWith(prefix)) return false;
  try {
    const raw = line.slice(prefix.length),
      value: unknown = JSON.parse(raw);
    return (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).join(",") === "runId,agentId,point,armId,generation" &&
      raw === JSON.stringify(value) &&
      Object.entries(arm).every(
        ([key, expected]) => (value as Record<string, unknown>)[key] === expected,
      )
    );
  } catch {
    return false;
  }
}

export async function armProcessBarrier(
  api: ProcessApi,
  runId: string,
  agentId: string,
  point: ProcessArm["point"],
  fault?: "hold" | "reject",
): Promise<Readonly<ProcessArm>> {
  const armId = randomUUID();
  const response = await api<ProcessArm>(`/__test/agents/${agentId}/fault`, {
    runId,
    armId,
    point,
    ...(fault ? { fault } : {}),
  });
  assert.equal(response.status, 200);
  assert.equal(Object.keys(response.body).sort().join(","), "agentId,armId,generation,point,runId");
  const { generation } = response.body;
  assert.ok(generationMatches(generation));
  const arm = Object.freeze({ runId, agentId, point, armId, generation });
  assert.deepEqual(response.body, arm);
  return arm;
}

export async function readProcessWitness(
  api: ProcessApi,
  arm: ProcessArm,
): Promise<ProcessWitness> {
  const response = await api<{ generation: string; witness: ProcessWitness | null }>(
    `/__test/agents/${arm.agentId}/barrier?arm=${arm.armId}&generation=${arm.generation}`,
  );
  assert.equal(response.status, 200);
  assert.ok(generationMatches(response.body.generation));
  assert.notEqual(
    response.body.generation,
    arm.generation,
    "Historical proof must be read by a replacement actor",
  );
  const witness = response.body.witness;
  assert.ok(witness, "Missing committed historical marker");
  const { admissions, ...identity } = witness;
  assert.deepEqual(identity, arm, "Historical marker belongs to the killed actor and exact arm");
  assert.ok(Array.isArray(admissions) && admissions.length <= 100);
  return witness;
}
