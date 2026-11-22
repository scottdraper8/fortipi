// Controlled public protocol fixtures only. liveContext's already-qualified
// Computer uploader is substituted; no installed/deployed/device proof is claimed.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mock, test } from "node:test";
import { promisify } from "node:util";
import type {
  CredentialMint,
  WorkspaceBinding,
} from "../../../packages/fortipi-contract/dist/index.js";
import { RoleContext } from "../../../tests/clients/roles.ts";
import type { Installed } from "../../../tests/distribution/install.ts";
import type { LiveDeviceOwnership } from "../../live-device-allocation.ts";
import { childEnvironment } from "../../prepare-release.ts";
import { canonicalJson, type DeploymentIdentity, sha256 } from "../../verify-release-gates.ts";

const clock = Date.now();
const admin = "synthetic-allocation-admin-canary-1010".repeat(2);
const origin = "https://allocation.invalid";
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const multi = Buffer.alloc(2 * 1024 * 1024);
for (let i = 0; i < multi.length; i++) multi[i] = (i * 31 + 1010) % 256;
const files = Object.entries({
  "notes.txt": Buffer.from("old-v1\n"),
  "binary.bin": Buffer.from([0, 255, 13, 10, 128, 1]),
  "multi.bin": multi,
})
  .map(([path, bytes]) => ({ path, size: bytes.length, sha256: hash(bytes) }))
  .sort((a, b) => a.path.localeCompare(b.path));
const manifestHash = hash(
  `fortipi:manifest:v1\n${canonicalJson({
    version: 1,
    entries: files.map((file) => ({ ...file, mode: 420, type: "file" })),
  })}`,
);
const binding: WorkspaceBinding = {
  workspaceId: "public-workspace",
  bindingVersion: 1,
  config: { kind: "computer" },
  revision: "r0",
  manifestHash,
  availability: "available",
};
const deployment: DeploymentIdentity = {
  schemaVersion: 1,
  candidateSha256: hash("candidate"),
  sourceCommit: "a".repeat(40),
  accountBindingSha256: hash("public-account-binding"),
  slot: "production",
  workerName: "fixture",
  origin,
  workerVersionId: "b".repeat(36),
  deploymentId: "c".repeat(36),
  versions: [{ versionId: "b".repeat(36), percentage: 100 }],
  configSha256: hash("config"),
  runtimeConfigSha256: hash("runtime"),
  assetManifestSha256: hash("assets"),
  publicConfigurationVersion: 1,
  capabilities: { plan: "free", loaders: false, containers: false },
  backend: "free",
  imageDigest: null,
  checkedAt: new Date(clock).toISOString(),
};
// No installation is executed in this protocol test; only these identity fields
// are read by the helper before handing Installed to substituted liveContext.
const installed = {
  hash: deployment.candidateSha256,
  candidate: {
    sourceCommit: deployment.sourceCommit,
    assetManifestSha256: deployment.assetManifestSha256,
  },
} as Installed;

async function controlled() {
  const nativeFetch = globalThis.fetch;
  let active: ReturnType<typeof fixture>;
  const seeds: { bootstrap: RoleContext }[] = [];
  mock.module(new URL("../../../tests/clients/live.ts", import.meta.url), {
    exports: {
      async liveContext(actual: Installed, observed: DeploymentIdentity, bootstrap: RoleContext) {
        assert.equal(actual, installed);
        assert.deepEqual(observed, deployment);
        seeds.push({ bootstrap });
        await bootstrap.call({
          operationId: "createAgent",
          path: {},
          query: {},
          body: {
            requestId: "fixed-helper-agent",
            name: "seed",
            model: { providerId: "cloudflare", modelId: "synthetic-model" },
          },
        });
        const auxiliary = () =>
          bootstrap.issue({
            requestId: "helper-mint",
            role: "client",
            expiresAt: clock + 600000,
            grants: [
              {
                grantId: "helper-grant",
                version: 1,
                resources: {
                  agentIds: [],
                  conversationIds: [],
                  workspaceIds: [],
                  executorIds: [],
                  backendIds: [],
                  tools: [],
                  actions: [],
                },
              },
            ],
          });
        await auxiliary();
        return {
          agent: { agentId: "public-agent" },
          conversations: [{ conversationId: "public-conversation" }],
          async workspace() {
            await bootstrap.call({
              operationId: "createWorkspace",
              path: {},
              query: {},
              body: { requestId: "fixed-helper-workspace", config: { kind: "computer" } },
            });
            const writer = await auxiliary(),
              reader = await auxiliary();
            await bootstrap.revoke(writer.credential.credentialId);
            await bootstrap.revoke(reader.credential.credentialId);
            return {
              observation: {
                workspaceId: binding.workspaceId,
                publishedRevision: binding.revision,
                files:
                  active.fault === "file"
                    ? files.map((file) => ({ ...file, sha256: "0".repeat(64) }))
                    : files,
              },
            };
          },
        };
      },
    },
  });
  const allocationModule: typeof import("../../live-device-allocation.ts") = await import(
    "../../live-device-allocation.ts"
  );
  const assertLiveDeviceOwnership: (value: unknown) => asserts value is LiveDeviceOwnership =
    allocationModule.assertLiveDeviceOwnership;
  const {
    allocateLiveDeviceRoles,
    allocateLiveDeviceReadRole,
    cleanupLiveDeviceRoles,
    LiveDeviceAllocationError,
  } = allocationModule;
  function fixture(fault = "") {
    const journals: LiveDeviceOwnership[] = [];
    const effects: { path: string; body: Record<string, unknown> }[] = [];
    const tokens: string[] = [];
    const revokeCounts = new Map<string, number>();
    let cleanupMode = "complete";
    let journalFailure = "";
    const roles = new RoleContext(origin, admin),
      bootstrapRoles = new RoleContext(origin, admin);
    const current = () => {
      const journal = journals.at(-1);
      assert.ok(journal, "Initial ownership must precede every public effect");
      return journal;
    };
    globalThis.fetch = async (url, init) => {
      assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${admin}`);
      const path = new URL(String(url)).pathname;
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      const journal = current();
      effects.push({ path, body });
      let result: unknown;
      if (path === "/v1/admin/credentials") {
        const row = journal.roles.find((row) => row.mintRequestId === body.requestId);
        assert.ok(row);
        assert.equal(row.issuance, "unknown", "Intent must be durable before mint");
        assert.equal(row.mintSha256, sha256(canonicalJson(body)));
        for (const earlier of journal.roles.slice(0, journal.roles.indexOf(row)))
          assert.equal(earlier.issuance, "known");
        if (
          (fault === "lost-issue" && row.name === "a") ||
          (fault === "lost-read" && journal.kind === "read")
        )
          throw new Error("Synthetic transport loss");
        const token = `synthetic-${row.name}-role-canary-${"x".repeat(32)}"\\\n`;
        tokens.push(token);
        const ref = {
          credentialId: `credential_${journal.kind}_${row.name}`,
          generation: journal.roles.indexOf(row) * 2 + 3,
          grantVersion: 4,
        };
        result =
          fault === "already-issued" && row.name === "a"
            ? {
                state: "already-issued",
                credential: ref,
                role: body.role,
                expiresAt: body.expiresAt,
              }
            : {
                state: "issued",
                credential: ref,
                role: body.role,
                expiresAt: body.expiresAt,
                token,
              };
      } else if (/^\/v1\/admin\/credentials\/[^/]+\/revoke$/.test(path)) {
        const credentialId = path.split("/")[4];
        const row = journal.roles.find((row) => row.credential?.credentialId === credentialId);
        assert.ok(row?.credential);
        assert.deepEqual(body, {
          requestId: row.revokeRequestId,
          expectedGeneration: row.credential.generation,
        });
        const count = (revokeCounts.get(credentialId!) ?? 0) + 1;
        revokeCounts.set(credentialId!, count);
        if (cleanupMode === "lost-revoke" && count % 3 !== 0)
          throw Error("Synthetic ambiguous revocation");
        const state =
          cleanupMode === "pending" || (cleanupMode === "first-pending" && count === 1)
            ? "pending"
            : "complete";
        result = {
          operationId: `operation_${credentialId}`,
          revocationId: `revocation_${credentialId}`,
          state,
          pendingRecipients:
            state === "pending" ? [{ kind: "workspace", id: binding.workspaceId }] : [],
        };
        if (cleanupMode === "unsafe-reply")
          result = { ...(result as object), operationId: tokens[0] };
      } else if (path === `/v1/workspaces/${binding.workspaceId}`) {
        result = fault === "binding" ? { ...binding, manifestHash: "0".repeat(64) } : binding;
      } else {
        assert.ok(
          ["/v1/agents", "/v1/workspaces"].includes(path),
          "No model/admission/execution operation in seeding",
        );
        result = {};
      }
      return Response.json(result);
    };
    return {
      fault,
      journals,
      effects,
      tokens,
      revokeCounts,
      roles,
      bootstrapRoles,
      set cleanupMode(value: string) {
        cleanupMode = value;
      },
      set journalFailure(value: string) {
        journalFailure = value;
      },
      async allocate() {
        return allocateLiveDeviceRoles({
          installed,
          deployment,
          roles,
          bootstrapRoles,
          now: () => clock,
          async writeJournal(journal) {
            for (const token of [admin, ...tokens]) {
              assert.ok(!JSON.stringify(journal).includes(token));
              assert.ok(!JSON.stringify(journal).includes(JSON.stringify(token).slice(1, -1)));
            }
            if (
              journalFailure === "initial" ||
              (journalFailure === "known" && journal.roles.some((row) => row.issuance === "known"))
            )
              throw Error("Synthetic journal unavailable");
            journals.push(structuredClone(journal));
          },
        });
      },
    };
  }
  try {
    // Successful allocation and cleanup from another context, independent of B
    // or either context's private issuance ledger. All cleanup refs are public.
    active = fixture();
    const allocation = await active.allocate();
    assert.notEqual(seeds[0]?.bootstrap, active.roles);
    assert.equal(allocation.ownership.state, "ready");
    assert.equal(allocation.seed.a.generation, 1);
    assert.equal(allocation.seed.b.generation, 1);
    assert.notEqual(allocation.aRole.credential.generation, allocation.seed.a.generation);
    assert.notEqual(allocation.seed.a.executorId, allocation.seed.b.executorId);
    assert.deepEqual(allocation.seed.workspace, { binding, files });
    const initial = active.journals[0];
    assert.ok(initial);
    assert.equal(initial.expiresAt - initial.createdAt, 45 * 60000);
    assert.ok(initial.roles.every((row) => row.issuance === "not-attempted"));
    for (const journal of active.journals)
      assert.deepEqual(
        journal.roles.map((row) => [row.mintRequestId, row.revokeRequestId, row.expiresAt]),
        initial.roles.map((row) => [row.mintRequestId, row.revokeRequestId, row.expiresAt]),
      );
    const mintBodies = active.effects
      .filter((row) => row.path === "/v1/admin/credentials")
      .map((row) => row.body as unknown as CredentialMint);
    assert.equal(mintBodies.length, 6);
    const carried = mintBodies.slice(3);
    for (const [index, request] of carried.entries()) {
      assert.equal(request.grants.length, 1);
      const grant = request.grants[0];
      assert.ok(grant);
      assert.equal(grant.version, 1);
      assert.deepEqual(
        grant.resources.actions,
        index === 0
          ? [
              "tickets.mint",
              "conversations.read",
              "messages.submit",
              "events.read",
              "tasks.read",
              "jobs.read",
              "jobs.dispatch",
              "approvals.read",
              "approvals.decide",
              "workspaces.read",
              "workspace.read",
              "workspace.write",
            ]
          : [
              "tickets.mint",
              "executors.register",
              "transfers.input",
              "transfers.output",
              "transfers.status",
              "workspace.read",
              "workspace.write",
              "artifacts.read",
            ],
      );
      assert.deepEqual(grant.resources.agentIds, ["public-agent"]);
      assert.deepEqual(grant.resources.conversationIds, ["public-conversation"]);
      assert.deepEqual(grant.resources.workspaceIds, [binding.workspaceId]);
      assert.deepEqual(grant.resources.backendIds, []);
      assert.deepEqual(grant.resources.tools, ["shell"]);
      const executors =
        index === 0
          ? [allocation.seed.a.executorId, allocation.seed.b.executorId]
          : [index === 1 ? allocation.seed.a.executorId : allocation.seed.b.executorId];
      assert.deepEqual(grant.resources.executorIds, executors);
      if (request.role === "executor") assert.equal(request.executorId, executors[0]);
      assert.ok(!Object.values(grant.resources).flat().includes("*"));
    }
    const fresh = new RoleContext(origin, admin);
    assert.deepEqual(await fresh.cleanup(), []);
    active.cleanupMode = "lost-revoke";
    const cleanup = await cleanupLiveDeviceRoles({
      roles: fresh,
      ownership: allocation.ownership,
      now: () => clock,
      suppliedTokens: active.tokens,
    });
    assert.equal(cleanup.state, "complete");
    assert.equal(cleanup.roles.filter((row) => row.receipt?.state === "complete").length, 6);
    assert.equal(
      active.effects.filter((row) => row.path === "/v1/admin/credentials").length,
      6,
      "Cleanup never remints",
    );
    active.cleanupMode = "pending";
    assert.equal(
      (
        await cleanupLiveDeviceRoles({
          roles: fresh,
          ownership: allocation.ownership,
          now: () => clock,
        })
      ).state,
      "pending",
    );
    active.cleanupMode = "unsafe-reply";
    const unsafe = await cleanupLiveDeviceRoles({
      roles: fresh,
      ownership: allocation.ownership,
      now: () => clock,
      suppliedTokens: active.tokens,
    });
    assert.equal(unsafe.state, "unknown");
    assert.ok(!JSON.stringify(unsafe).includes(JSON.stringify(active.tokens[0]).slice(1, -1)));
    process.stdout.write(
      "Fixed intent, exact scopes/bytes and independent bounded cleanup passed.\n",
    );

    // Lost issuance must remain unknown even after expiry; an already-issued
    // reply supplies cleanup ownership but cannot recover a token or continue.
    for (const fault of ["lost-issue", "already-issued"]) {
      active = fixture(fault);
      let failure: InstanceType<typeof LiveDeviceAllocationError> | undefined;
      try {
        await active.allocate();
      } catch (error) {
        assert.ok(error instanceof LiveDeviceAllocationError);
        failure = error;
      }
      assert.ok(failure);
      assert.equal(failure.ownership.state, "blocked");
      assert.equal(active.effects.filter((row) => row.path === "/v1/admin/credentials").length, 5);
      const failed = failure.ownership.roles.find((row) => row.name === "a");
      assert.ok(failed);
      assert.equal(failed.issuance, fault === "lost-issue" ? "unknown" : "known");
      const result = await cleanupLiveDeviceRoles({
        roles: new RoleContext(origin, admin),
        ownership: failure.ownership,
        now: () => clock + 46 * 60000,
      });
      assert.equal(result.state, fault === "lost-issue" ? "unknown" : "complete");
      assert.equal(active.effects.filter((row) => row.path === "/v1/admin/credentials").length, 5);
    }
    process.stdout.write("Ambiguous and one-time issuance remain blocked without reminting.\n");

    // Bad seed/public binding cannot mint carried roles; journal write loss
    // cannot issue another role after a known reference or before first intent.
    for (const fault of ["file", "binding", "initial", "known"]) {
      active = fixture(fault);
      if (["initial", "known"].includes(fault)) active.journalFailure = fault;
      await assert.rejects(active.allocate(), LiveDeviceAllocationError);
      const mints = active.effects.filter((row) => row.path === "/v1/admin/credentials");
      assert.equal(mints.length, fault === "initial" ? 0 : fault === "known" ? 1 : 3);
      assert.ok(
        active.effects.every(
          (row) =>
            !["a", "b", "client"].some(
              (name) =>
                active.journals[0]?.roles.find((role) => role.name === name)?.mintRequestId ===
                row.body.requestId,
            ),
        ),
      );
    }
    process.stdout.write("Changed seed/binding and unavailable journal stop subsequent effects.\n");

    // Only the historical initial projection is needed here. Full A/B lineage
    // authentication remains the caller's job; no old custody is opened.
    const v1 = {
      ...deployment,
      workerVersionId: "d".repeat(36),
      deploymentId: "e".repeat(36),
      versions: [{ versionId: "d".repeat(36), percentage: 100 }],
    };
    const devices = { initial: { deployment, seed: allocation.seed } };
    const bootstrapCount = seeds.length;
    for (const fault of ["", "lost-read"]) {
      active = fixture(fault);
      let failed: InstanceType<typeof LiveDeviceAllocationError> | undefined;
      let result: Awaited<ReturnType<typeof allocateLiveDeviceReadRole>> | undefined;
      try {
        result = await allocateLiveDeviceReadRole({
          roles: active.roles,
          deployment: v1,
          devices,
          now: () => clock,
          async writeJournal(journal) {
            assertLiveDeviceOwnership(journal);
            active.roles.assertSanitized(journal, active.tokens);
            active.journals.push(structuredClone(journal));
          },
        });
      } catch (error) {
        assert.ok(error instanceof LiveDeviceAllocationError);
        failed = error;
      }
      const saved = result?.ownership ?? failed?.ownership;
      assert.ok(saved);
      assertLiveDeviceOwnership(saved);
      assert.equal(saved.kind, "read");
      assert.equal(saved.roles.length, 1);
      assert.deepEqual(saved.deployment, v1);
      assert.deepEqual(saved.executorIds, allocation.ownership.executorIds);
      assert.equal(seeds.length, bootstrapCount);
      assert.equal(active.effects.length, 1);
      const request = active.effects[0]?.body as unknown as CredentialMint;
      assert.equal(request.role, "client");
      assert.equal("executorId" in request, false);
      assert.deepEqual(request.grants[0]?.resources.actions, [
        "tickets.mint",
        "conversations.read",
        "events.read",
        "tasks.read",
        "jobs.read",
        "workspace.read",
        "workspaces.read",
      ]);
      assert.deepEqual(request.grants[0]?.resources.executorIds, [
        allocation.seed.a.executorId,
        allocation.seed.b.executorId,
      ]);
      assert.notEqual(saved.roles[0]?.mintRequestId, allocation.ownership.roles[3]?.mintRequestId);
      assert.equal(saved.state, fault ? "blocked" : "ready");
      const cleanup = await cleanupLiveDeviceRoles({
        roles: new RoleContext(origin, admin),
        ownership: saved,
        now: () => clock,
      });
      assert.equal(cleanup.state, fault ? "unknown" : "complete");
      assert.equal(active.effects.filter((row) => row.path === "/v1/admin/credentials").length, 1);
      assert.throws(() =>
        assertLiveDeviceOwnership({ ...saved, roles: allocation.ownership.roles }),
      );
      assert.throws(() => assertLiveDeviceOwnership({ ...saved, token: active.tokens[0] }));
    }
    process.stdout.write(
      "New V1-bound read-only issuance and public ownership validation passed.\n",
    );
  } finally {
    globalThis.fetch = nativeFetch;
    mock.restoreAll();
  }
}

if (process.argv.includes("--allocation-protocol")) {
  await controlled();
} else {
  test("live device allocation journals public ownership before effects and preserves uncertain cleanup", {
    timeout: 30000,
  }, async () => {
    const result = await promisify(execFile)(
      process.execPath,
      ["--experimental-test-module-mocks", import.meta.filename, "--allocation-protocol"],
      { env: childEnvironment(), timeout: 25000, maxBuffer: 100000 },
    );
    assert.match(result.stdout, /independent bounded cleanup passed/);
    assert.match(result.stdout, /without reminting/);
    assert.match(result.stdout, /stop subsequent effects/);
    assert.match(result.stdout, /read-only issuance/);
  });
}
