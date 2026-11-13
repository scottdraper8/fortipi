import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  type CredentialMint,
  type CredentialRef,
  manifestDigest,
  type RevocationReceipt,
  schemaRefs,
  schemaRegistry,
} from "../packages/fortipi-contract/dist/index.js";
import { liveContext } from "../tests/clients/live.ts";
import {
  type DeviceContinuitySeed,
  deviceResources,
  deviceSeedBytes,
} from "../tests/clients/live-device.ts";
import type { IssuedRole, RoleContext } from "../tests/clients/roles.ts";
import type { Installed } from "../tests/distribution/install.ts";
import {
  assertDeployment,
  canonicalJson,
  type DeploymentIdentity,
  sha256,
} from "./verify-release-gates.ts";

const names = [
  "bootstrap-client",
  "workspace-writer",
  "workspace-reader",
  "client",
  "a",
  "b",
] as const;
type RoleName = (typeof names)[number];
export interface LiveDeviceOwnedRole {
  name: RoleName;
  role: "client" | "executor";
  mintRequestId: string;
  revokeRequestId: string;
  grantId: string;
  expiresAt: number;
  issuance: "not-attempted" | "unknown" | "known";
  mintSha256?: string;
  credential?: CredentialRef;
}
/** Public cleanup ownership only. Authentication of its retained artifact is the
 * caller's responsibility; this object never grants coordinator authority. */
export interface LiveDeviceOwnership {
  schemaVersion: 1;
  kind: "perform" | "read";
  allocationId: string;
  candidateSha256: string;
  sourceCommit: string;
  deployment: DeploymentIdentity;
  createdAt: number;
  expiresAt: number;
  executorIds: { a: string; b: string };
  state: "allocating" | "ready" | "blocked";
  roles: LiveDeviceOwnedRole[];
}
export interface LiveDeviceRoleCleanup {
  name: RoleName;
  requestId: string;
  credential?: CredentialRef;
  state: "not-issued" | "complete" | "pending" | "unknown";
  receipt?: RevocationReceipt;
}
export interface LiveDeviceCleanup {
  state: "complete" | "pending" | "unknown";
  roles: LiveDeviceRoleCleanup[];
}
export class LiveDeviceAllocationError extends Error {
  readonly ownership: LiveDeviceOwnership;
  constructor(ownership: LiveDeviceOwnership) {
    super("Live device allocation unavailable; retain ownership and perform public cleanup");
    this.ownership = structuredClone(ownership);
  }
}

const validators = new Map<string, (value: unknown) => boolean>();
function wire(
  name: "CredentialRef" | "CredentialReceipt" | "RevocationReceipt" | "WorkspaceBinding",
  value: unknown,
) {
  if (!validators.size) {
    const ajv = new Ajv2020({ strict: true, allErrors: false, validateFormats: false });
    for (const schema of Object.values(schemaRegistry)) ajv.addSchema(schema);
    for (const key of [
      "CredentialRef",
      "CredentialReceipt",
      "RevocationReceipt",
      "WorkspaceBinding",
    ] as const)
      validators.set(key, ajv.compile({ $ref: schemaRefs[key] }));
  }
  assert.ok(validators.get(name)?.(value), "Invalid public allocation response");
}
function id(value: string) {
  assert.match(value, /^[A-Za-z0-9_-]{1,128}$/);
  assert.notEqual(value, "*");
}
function ownership(value: LiveDeviceOwnership) {
  assert.ok(Buffer.byteLength(JSON.stringify(value)) <= 65536);
  assert.deepEqual(
    Object.keys(value).sort(),
    [
      "schemaVersion",
      "kind",
      "allocationId",
      "candidateSha256",
      "sourceCommit",
      "deployment",
      "createdAt",
      "expiresAt",
      "executorIds",
      "state",
      "roles",
    ].sort(),
  );
  assert.equal(value.schemaVersion, 1);
  assert.ok(value.kind === "perform" || value.kind === "read");
  id(value.allocationId);
  assertDeployment(value.deployment);
  assert.equal(value.candidateSha256, value.deployment.candidateSha256);
  assert.equal(value.sourceCommit, value.deployment.sourceCommit);
  assert.ok(["allocating", "ready", "blocked"].includes(value.state));
  assert.ok(Number.isSafeInteger(value.createdAt) && value.createdAt > 0);
  assert.ok(Number.isSafeInteger(value.expiresAt) && value.expiresAt > value.createdAt);
  assert.ok(value.expiresAt - value.createdAt <= 45 * 60000);
  assert.deepEqual(Object.keys(value.executorIds).sort(), ["a", "b"]);
  for (const executor of Object.values(value.executorIds)) id(executor);
  assert.notEqual(value.executorIds.a, value.executorIds.b);
  assert.deepEqual(
    value.roles.map((role) => role.name),
    value.kind === "perform" ? names : ["client"],
  );
  const requests: string[] = [];
  for (const [index, role] of value.roles.entries()) {
    assert.ok(
      Object.keys(role).every((key) =>
        [
          "name",
          "role",
          "mintRequestId",
          "revokeRequestId",
          "grantId",
          "expiresAt",
          "issuance",
          "mintSha256",
          "credential",
        ].includes(key),
      ),
    );
    assert.equal(role.role, index < 4 ? "client" : "executor");
    for (const request of [role.mintRequestId, role.revokeRequestId, role.grantId]) {
      id(request);
      requests.push(request);
    }
    assert.ok(Number.isSafeInteger(role.expiresAt));
    assert.ok(role.expiresAt > value.createdAt && role.expiresAt <= value.expiresAt);
    assert.ok(["not-attempted", "unknown", "known"].includes(role.issuance));
    if (role.issuance === "not-attempted") {
      assert.equal(role.credential, undefined);
      assert.equal(role.mintSha256, undefined);
    } else assert.match(role.mintSha256 ?? "", /^[a-f0-9]{64}$/);
    if (role.issuance === "known") wire("CredentialRef", role.credential);
    else assert.equal(role.credential, undefined);
  }
  assert.equal(new Set(requests).size, requests.length);
  if (value.state === "ready") {
    assert.ok(value.roles.every((role) => role.issuance === "known"));
    assert.equal(
      new Set(value.roles.map((role) => role.credential?.credentialId)).size,
      value.roles.length,
    );
  }
}

/** Structural validation only: never authenticates source, mode, job or caller. */
export function assertLiveDeviceOwnership(value: unknown): asserts value is LiveDeviceOwnership {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  ownership(value as LiveDeviceOwnership);
}

/** Replays only the saved, idempotent revocation request, never an issuance.
 * A fresh RoleContext for the SAME issuing admin principal works after B fails.
 * Expiry alone cannot turn missing references or failed calls into completion. */
export async function cleanupLiveDeviceRoles(input: {
  roles: RoleContext;
  ownership: LiveDeviceOwnership;
  now?: () => number;
  suppliedTokens?: readonly string[];
}): Promise<LiveDeviceCleanup> {
  const saved = structuredClone(input.ownership);
  ownership(saved);
  assert.equal(input.roles.endpoint, saved.deployment.origin);
  const sanitized = (value: unknown) => input.roles.assertSanitized(value, input.suppliedTokens);
  sanitized(saved);
  const now = input.now ?? Date.now;
  assert.ok(Number.isSafeInteger(now()) && now() >= saved.createdAt);
  const rows = await Promise.all(
    saved.roles.map(async (role): Promise<LiveDeviceRoleCleanup> => {
      const base = { name: role.name, requestId: role.revokeRequestId };
      if (role.issuance === "not-attempted") return { ...base, state: "not-issued" };
      if (!role.credential) return { ...base, state: "unknown" };
      let receipt: RevocationReceipt | undefined;
      let state: "complete" | "pending" | "unknown" = "unknown";
      const deadline = now() + 90000;
      for (let attempt = 0; attempt < 3 && now() < deadline; attempt++) {
        try {
          const current: RevocationReceipt = await input.roles.call({
            operationId: "revokeCredential",
            path: { id: role.credential.credentialId },
            query: {},
            body: {
              requestId: role.revokeRequestId,
              expectedGeneration: role.credential.generation,
            },
          });
          wire("RevocationReceipt", current);
          sanitized(current);
          if (receipt) {
            assert.equal(current.operationId, receipt.operationId);
            assert.equal(current.revocationId, receipt.revocationId);
          }
          receipt = structuredClone(current);
          state = current.state;
          if (state === "complete") break;
        } catch {
          // An unobserved/malformed reply is uncertainty, not successful cleanup.
          state = "unknown";
        }
        if (attempt < 2) await delay(100);
      }
      return { ...base, credential: role.credential, state, ...(receipt ? { receipt } : {}) };
    }),
  );
  const result: LiveDeviceCleanup = {
    state: rows.some((row) => row.state === "unknown")
      ? "unknown"
      : rows.some((row) => row.state === "pending")
        ? "pending"
        : "complete",
    roles: rows,
  };
  sanitized(result);
  return result;
}

function journalOperations(
  saved: LiveDeviceOwnership,
  input: {
    roles: RoleContext;
    bootstrapRoles?: RoleContext;
    writeJournal: (journal: LiveDeviceOwnership) => Promise<void>;
  },
  now: () => number,
) {
  const tokens: string[] = [];
  const sanitized = (value: unknown) => {
    input.roles.assertSanitized(value, tokens);
    input.bootstrapRoles?.assertSanitized(value, tokens);
  };
  const save = async () => {
    ownership(saved);
    sanitized(saved);
    await input.writeJournal(structuredClone(saved));
  };
  async function mint(
    context: RoleContext,
    role: LiveDeviceOwnedRole,
    proposed: CredentialMint,
  ): Promise<IssuedRole> {
    assert.equal(role.issuance, "not-attempted");
    assert.ok(now() < role.expiresAt);
    assert.equal(proposed.role, role.role);
    assert.equal(proposed.grants.length, 1);
    const request: CredentialMint = {
      ...proposed,
      requestId: role.mintRequestId,
      expiresAt: role.expiresAt,
      grants: [{ ...proposed.grants[0]!, grantId: role.grantId }],
    };
    role.issuance = "unknown";
    role.mintSha256 = sha256(canonicalJson(request));
    await save();
    // Never retry mint: identical replay cannot recover the one-time raw token.
    const result = await context.call({
      operationId: "mintCredential",
      path: {},
      query: {},
      body: request,
    });
    if ("token" in result && typeof result.token === "string") tokens.push(result.token);
    wire("CredentialRef", result.credential);
    role.credential = structuredClone(result.credential);
    role.issuance = "known";
    await save();
    wire("CredentialReceipt", result);
    assert.equal(result.role, role.role);
    assert.equal(result.expiresAt, role.expiresAt);
    assert.equal(result.state, "issued", "An already-issued token cannot be recovered");
    assert.ok(now() < role.expiresAt);
    if (result.state !== "issued") throw new Error("Role token unavailable");
    return result;
  }
  return { tokens, sanitized, save, mint };
}

function createOwnership(
  kind: LiveDeviceOwnership["kind"],
  deployment: DeploymentIdentity,
  createdAt: number,
  executorIds: { a: string; b: string },
): LiveDeviceOwnership {
  return {
    schemaVersion: 1,
    kind,
    allocationId: randomUUID(),
    candidateSha256: deployment.candidateSha256,
    sourceCommit: deployment.sourceCommit,
    deployment: structuredClone(deployment),
    createdAt,
    expiresAt: createdAt + 45 * 60000,
    executorIds,
    state: "allocating",
    roles: (kind === "perform" ? names : (["client"] as const)).map((name, index) => ({
      name,
      role: index < 4 ? "client" : "executor",
      mintRequestId: randomUUID(),
      revokeRequestId: randomUUID(),
      grantId: randomUUID(),
      expiresAt: createdAt + (kind === "perform" && index < 3 ? 15 : 45) * 60000,
      issuance: "not-attempted",
    })),
  };
}

/** devices is precisely the initial projection of Chief's DeviceEvidenceData;
 * caller must first authenticate the complete historical A/B/cleanup lineage.
 * deployment is the independently observed current V1, never historical V0.
 * This only mints a NEW read client; it never opens original custody or seeds. */
export async function allocateLiveDeviceReadRole(input: {
  roles: RoleContext;
  deployment: DeploymentIdentity;
  devices: { initial: { deployment: DeploymentIdentity; seed: DeviceContinuitySeed } };
  writeJournal: (journal: LiveDeviceOwnership) => Promise<void>;
  now?: () => number;
}): Promise<{ clientRole: IssuedRole; ownership: LiveDeviceOwnership }> {
  const { seed, deployment: original } = input.devices.initial;
  assertDeployment(original);
  assertDeployment(input.deployment);
  assert.equal(input.roles.endpoint, input.deployment.origin);
  for (const key of [
    "sourceCommit",
    "candidateSha256",
    "accountBindingSha256",
    "origin",
    "workerName",
    "slot",
    "configSha256",
    "runtimeConfigSha256",
    "assetManifestSha256",
    "publicConfigurationVersion",
    "capabilities",
    "backend",
    "imageDigest",
  ] as const)
    assert.deepEqual(input.deployment[key], original[key], "Historical read target changed");
  for (const value of [
    seed.agentId,
    seed.conversationId,
    seed.workspace.binding.workspaceId,
    seed.a.executorId,
    seed.b.executorId,
  ])
    id(value);
  assert.notEqual(seed.a.executorId, seed.b.executorId);
  wire("WorkspaceBinding", seed.workspace.binding);
  assert.equal(seed.workspace.binding.config.kind, "computer");
  const now = input.now ?? Date.now;
  const saved = createOwnership("read", input.deployment, now(), {
    a: seed.a.executorId,
    b: seed.b.executorId,
  });
  const { save, mint, sanitized } = journalOperations(saved, input, now);
  try {
    await save();
    const row = saved.roles[0];
    assert.ok(row);
    const clientRole = await mint(input.roles, row, {
      requestId: row.mintRequestId,
      role: "client",
      grants: [
        {
          grantId: row.grantId,
          version: 1,
          resources: {
            ...deviceResources(seed),
            actions: [
              "tickets.mint",
              "conversations.read",
              "events.read",
              "tasks.read",
              "jobs.read",
              "workspace.read",
              "workspaces.read",
            ],
          },
        },
      ],
    });
    saved.state = "ready";
    await save();
    return { clientRole, ownership: structuredClone(saved) };
  } catch {
    saved.state = "blocked";
    try {
      await save();
    } catch {
      /* Preserve uncertainty in the last durable journal. */
    }
    sanitized(saved);
    throw new LiveDeviceAllocationError(saved);
  }
}

/** Trusted in-process allocation only, no CLI/provider/GitHub authority. Both
 * contexts must use the same existing admin principal; bootstrapRoles must be
 * separate. Returned IssuedRoles remain private memory for the custody caller.
 * writeJournal must initialize exclusively, retain the same allocationId on
 * updates, and durably save each token-free snapshot before resolving.
 * Never call allocation again to replace an uncertain issuance. */
export async function allocateLiveDeviceRoles(input: {
  installed: Installed;
  deployment: DeploymentIdentity;
  roles: RoleContext;
  bootstrapRoles: RoleContext;
  writeJournal: (journal: LiveDeviceOwnership) => Promise<void>;
  now?: () => number;
}): Promise<{
  seed: DeviceContinuitySeed;
  clientRole: IssuedRole;
  aRole: IssuedRole;
  bRole: IssuedRole;
  ownership: LiveDeviceOwnership;
}> {
  assertDeployment(input.deployment);
  assert.equal(input.deployment.candidateSha256, input.installed.hash);
  assert.equal(input.deployment.sourceCommit, input.installed.candidate.sourceCommit);
  assert.equal(input.deployment.assetManifestSha256, input.installed.candidate.assetManifestSha256);
  assert.notEqual(input.roles, input.bootstrapRoles, "Separate bootstrap role context required");
  for (const roles of [input.roles, input.bootstrapRoles])
    assert.equal(roles.endpoint, input.deployment.origin);
  const now = input.now ?? Date.now;
  const createdAt = now();
  const saved = createOwnership("perform", input.deployment, createdAt, {
    a: randomUUID(),
    b: randomUUID(),
  });
  const { tokens, sanitized, save, mint } = journalOperations(saved, input, now);
  // This write precedes even the existing helper's createAgent/workspace effects.
  try {
    await save();
  } catch {
    saved.state = "blocked";
    throw new LiveDeviceAllocationError(saved);
  }
  let auxiliary = 0;
  // Adapt only public methods. No private ledger/admin access, upload algorithm
  // or additional authority is copied from the existing qualified seed helper.
  const bootstrap = new Proxy(input.bootstrapRoles, {
    get(target, property) {
      if (property === "issue")
        return (proposed: CredentialMint) => {
          assert.ok(auxiliary < 3, "Unexpected auxiliary seed role");
          return mint(target, saved.roles[auxiliary++]!, proposed);
        };
      if (property === "assertSanitized") return sanitized;
      if (property === "revoke")
        return async (credentialId: string) => {
          const role = saved.roles
            .slice(0, 3)
            .find((row) => row.credential?.credentialId === credentialId);
          assert.ok(role?.credential, "Only owned auxiliary seed roles may be revoked");
          const receipt = await target.call({
            operationId: "revokeCredential",
            path: { id: credentialId },
            query: {},
            body: {
              requestId: role.revokeRequestId,
              expectedGeneration: role.credential.generation,
            },
          });
          wire("RevocationReceipt", receipt);
          sanitized(receipt);
          return receipt;
        };
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  try {
    const live = await liveContext(input.installed, input.deployment, bootstrap);
    const evidence = await live.workspace();
    const observation: Record<string, unknown> = evidence.observation;
    assert.equal(auxiliary, 3, "Exact existing bootstrap/writer/reader recipe required");
    const workspaceId = observation.workspaceId;
    assert.equal(typeof workspaceId, "string");
    id(workspaceId as string);
    const binding = await input.roles.call({
      operationId: "describeWorkspace",
      path: { workspaceId: workspaceId as string },
      query: {},
      body: undefined,
    });
    wire("WorkspaceBinding", binding);
    assert.equal(binding.workspaceId, workspaceId);
    assert.equal(binding.config.kind, "computer");
    assert.equal(binding.revision, observation.publishedRevision);
    assert.equal(binding.availability, "available");
    const files = Object.entries(deviceSeedBytes())
      .map(([path, bytes]) => ({ path, size: bytes.length, sha256: sha256(bytes) }))
      .sort((a, b) => a.path.localeCompare(b.path));
    const observed = observation.files;
    assert.ok(Array.isArray(observed));
    assert.deepEqual(
      [...observed].sort((a, b) => String(a.path).localeCompare(String(b.path))),
      files,
    );
    assert.equal(
      binding.manifestHash,
      await manifestDigest({
        version: 1,
        entries: files.map((file) => ({ ...file, type: "file", mode: 420 })),
      }),
    );
    const cleanup = await cleanupLiveDeviceRoles({
      roles: input.bootstrapRoles,
      ownership: saved,
      now,
      suppliedTokens: tokens,
    });
    sanitized(cleanup);
    assert.equal(
      cleanup.state,
      "complete",
      "Auxiliary seed cleanup must complete before carrying roles",
    );
    const seed: DeviceContinuitySeed = {
      agentId: live.agent.agentId,
      conversationId: live.conversations[0]!.conversationId,
      workspace: { binding, files },
      // Minting a fresh executor ID creates generation 1 (Identities.mint).
      // CredentialRef.generation is a different authority and is never copied.
      a: { executorId: saved.executorIds.a, generation: 1 },
      b: { executorId: saved.executorIds.b, generation: 1 },
    };
    id(seed.agentId);
    id(seed.conversationId);
    const issue = (index: number, proposed: CredentialMint) =>
      mint(input.roles, saved.roles[index]!, proposed);
    const clientRole = await issue(3, {
      requestId: saved.roles[3]!.mintRequestId,
      role: "client",
      grants: [{ grantId: saved.roles[3]!.grantId, version: 1, resources: deviceResources(seed) }],
    });
    const aRole = await issue(4, {
      requestId: saved.roles[4]!.mintRequestId,
      role: "executor",
      executorId: seed.a.executorId,
      grants: [
        { grantId: saved.roles[4]!.grantId, version: 1, resources: deviceResources(seed, seed.a) },
      ],
    });
    const bRole = await issue(5, {
      requestId: saved.roles[5]!.mintRequestId,
      role: "executor",
      executorId: seed.b.executorId,
      grants: [
        { grantId: saved.roles[5]!.grantId, version: 1, resources: deviceResources(seed, seed.b) },
      ],
    });
    assert.equal(new Set(saved.roles.map((row) => row.credential?.credentialId)).size, 6);
    sanitized(seed);
    saved.state = "ready";
    await save();
    return { seed, clientRole, aRole, bRole, ownership: structuredClone(saved) };
  } catch {
    saved.state = "blocked";
    try {
      await save();
    } catch {
      /* The last durable journal can still be uncertain. */
    }
    sanitized(saved);
    throw new LiveDeviceAllocationError(saved);
  }
}
