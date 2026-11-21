import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { canonicalJson, type Job } from "../../packages/fortipi-contract/dist/index.js";
import {
  assertSelectionAcceptanceData,
  type SelectionAcceptanceData,
  type SelectionCaseProof,
  selectionTarget,
} from "../../scripts/live-selection-evidence.ts";
import { type DeploymentIdentity, sha256 } from "../../scripts/verify-release-gates.ts";
import type { DeviceEvidenceData } from "./device-observer.ts";
import {
  liveRecoveryReady,
  readDeviceEvidenceData,
  readSelectionEvidenceData,
} from "./evidence.ts";
import { deviceSeedBytes } from "./live-device.ts";
import { parseSelectionExport, selectionAttempt, selectionCases } from "./live-selection-tools.ts";
import { argumentsFor } from "./run-evidence.ts";

async function metadataFixture(): Promise<{
  data: DeviceEvidenceData;
  current: DeploymentIdentity;
  jobs: Map<string, Job>;
}> {
  // Reuse the controlled read fixture without importing/registering its tests.
  // No candidate, provider, phase artifact or job authenticity is fabricated.
  const source = await readFile(new URL("./device-observer.test.ts", import.meta.url), "utf8");
  const start = source.indexOf("const hash ="),
    end = source.indexOf("\ntest(", start);
  assert.ok(start >= 0 && end > start);
  const construct = new Function(
    "assert",
    "createHash",
    "canonicalJson",
    "deviceSeedBytes",
    `${stripTypeScriptTypes(source.slice(start, end))}\nreturn controlledHistory();`,
  );
  const {
    data,
    current,
    client,
  }: {
    data: DeviceEvidenceData;
    current: DeploymentIdentity;
    client: { jobs: { get(id: string): Promise<Job> } };
  } = construct(assert, createHash, canonicalJson, deviceSeedBytes);
  const provider0 = "00000000-0000-4000-8000-000000000010",
    worker0 = "00000000-0000-4000-8000-000000000020";
  const provider1 = "00000000-0000-4000-8000-000000000011",
    worker1 = "00000000-0000-4000-8000-000000000021";
  Object.assign(data.initial.deployment, {
    deploymentId: provider0,
    workerVersionId: worker0,
    versions: [{ versionId: worker0, percentage: 100 }],
  });
  data.a.deploymentId = provider0;
  data.b.deploymentId = provider0;
  data.a.workerVersionId = worker0;
  data.b.workerVersionId = worker0;
  Object.assign(current, {
    deploymentId: provider1,
    workerVersionId: worker1,
    versions: [{ versionId: worker1, percentage: 100 }],
  });
  const jobs = new Map([[data.a.jobId, await client.jobs.get(data.a.jobId)]]);
  return { data, current, jobs };
}

async function selectionFixture(): Promise<{
  data: SelectionAcceptanceData;
  current: DeploymentIdentity;
}> {
  // Schema-valid controlled public facts. No producer/artifact/provider authority
  // is conferred by this fixture or by the transport reader being tested.
  const { data: device, current, jobs } = await metadataFixture();
  const operator = JSON.parse(
    await readFile(
      new URL("../../packages/fortipi-cli/templates/operator-config.example.json", import.meta.url),
      "utf8",
    ),
  );
  operator.runtime.routing = { kind: "prefer-local", targetIds: [] };
  const target = {
    schemaVersion: 1 as const,
    backend: "free" as const,
    accountBindingSha256: current.accountBindingSha256,
    operator,
  };
  const ids: [string, string] = ["selection-a", "selection-b"];
  const targets = ids.map((executorId) => ({
    kind: "executor" as const,
    executorId,
    generation: 1,
  }));
  const phases = (["a", "b", "f"] as const).map((phase, index) => {
    const workerVersionId = `00000000-0000-4000-8000-00000000003${index}`;
    return {
      phase,
      target:
        phase === "f" ? target : selectionTarget(target, index === 0 ? ids : [...ids].reverse()),
      deployment: {
        ...current,
        workerVersionId,
        deploymentId: `00000000-0000-4000-8000-00000000004${index}`,
        versions: [{ versionId: workerVersionId, percentage: 100 }],
      },
    };
  });
  Object.assign(current, phases[2]!.deployment);
  const baseJob = jobs.get("job-a");
  assert.ok(baseJob && baseJob.state === "completed" && baseJob.evidence.kind === "committed");
  const baseReceipt = baseJob.evidence.receipt;
  const workspace = {
    binding: structuredClone(device.initial.seed.workspace.binding),
    files: [device.initial.seed.workspace.files.find((file) => file.path === "notes.txt")!],
  };
  const cases: SelectionCaseProof[] = selectionCases.map((name, index) => {
    const positive = index < 3,
      selected = targets[name === "preferred-b" ? 1 : 0]!,
      ranked = index === 0 ? ids : [...ids].reverse();
    const admission = {
      operationId: `input-${index}`,
      messageId: `user-${index}`,
      taskId: `task-${index}`,
      revision: `conversation-${index}`,
      eventSeq: 1,
    };
    const task = {
      taskId: admission.taskId,
      conversationId: `conversation-${index}`,
      version: 1,
      status: { state: "completed" as const },
    };
    const receipt = {
      ...baseReceipt,
      workspaceId: workspace.binding.workspaceId,
      baseRevision: workspace.binding.revision,
      revision: `published-${index}`,
      commitId: `commit-${index}`,
      jobId: `job-${index}`,
    };
    const job = positive
      ? {
          ...structuredClone(baseJob),
          jobId: `job-${index}`,
          taskId: admission.taskId,
          conversationId: task.conversationId,
          evidence: { kind: "committed" as const, receipt },
        }
      : undefined;
    const context = {
      routing: { kind: "prefer-local", targetIds: ranked },
      argumentContracts: { "native-shell": "command string" },
      targets: targets.map((target) => ({
        target,
        argumentFormat: "native-shell",
        platform: "linux",
        capabilities: ["shell"],
      })),
      workspaces: [
        {
          workspaceId: workspace.binding.workspaceId,
          baseRevision: workspace.binding.revision,
          bindingVersion: 1,
          provider: "computer",
          configured: true,
          targets,
        },
      ],
    };
    const args = {
      tool: "shell",
      arguments: { command: "cat notes.txt" },
      workspaceId: workspace.binding.workspaceId,
      baseRevision: workspace.binding.revision,
      capabilities: ["shell"],
      ...(index === 0 || index === 1 ? {} : { target: selected }),
    };
    const refusal: NonNullable<Parameters<typeof selectionAttempt>[1]["refusal"]> =
      name === "stale-revision"
        ? "Workspace base changed"
        : "No currently eligible configured target accepts these tool arguments";
    const entries = [
      {
        id: 1,
        kind: "pi.assistant",
        byTaskId: 1,
        model: [
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "context",
                name: "fortipi_context",
                arguments: { tool: "shell", capabilities: ["shell"] },
              },
            ],
          },
        ],
      },
      {
        id: 2,
        kind: "pi.tool-result",
        byTaskId: 2,
        model: [
          {
            role: "toolResult",
            toolCallId: "context",
            toolName: "fortipi_context",
            timestamp: 100,
            isError: false,
            content: [{ type: "text", text: JSON.stringify(context) }],
          },
        ],
      },
      {
        id: 3,
        kind: "pi.assistant",
        byTaskId: 3,
        model: [
          {
            role: "assistant",
            content: [
              { type: "toolCall", id: "dispatch", name: "fortipi_dispatch", arguments: args },
            ],
          },
        ],
      },
      {
        id: 4,
        kind: "pi.tool-result",
        byTaskId: 4,
        model: [
          {
            role: "toolResult",
            toolCallId: "dispatch",
            toolName: "fortipi_dispatch",
            timestamp: 200,
            isError: !positive,
            content: [{ type: "text", text: positive ? "saved" : `[error] ${refusal}` }],
          },
        ],
        data: { diagnostics: positive ? [] : [{ code: "tool_error", message: refusal }] },
      },
    ];
    const rows = [
      { type: "fortipi.agent.export", version: 1, exportId: "export", agentId: "agent" },
      {
        type: "conversation",
        conversation: { agentId: "agent", conversationId: task.conversationId },
        through: 1,
        piEntryThrough: 4,
      },
      ...entries.map((entry) => ({ type: "entry", conversationId: task.conversationId, entry })),
      ...(job ? [{ type: "job", job }] : []),
    ];
    const transcript = parseSelectionExport(
      Buffer.from(rows.map((row) => JSON.stringify(row)).join("\n")),
      "agent",
      task.conversationId,
      ["synthetic-unused-secret"],
    );
    const expected = {
      workspaceId: workspace.binding.workspaceId,
      baseRevision: workspace.binding.revision,
      targets,
      ranked,
      selected,
      mode: index < 2 ? ("omitted" as const) : ("explicit" as const),
      ...(!positive ? { refusal } : {}),
    };
    const calls = selectionAttempt(transcript, expected);
    const firstFile = workspace.files[0]!;
    return {
      name,
      agentId: "agent",
      conversationId: task.conversationId,
      admission,
      task,
      ...(!positive
        ? {
            inspectAdmission: {
              ...admission,
              taskId: `inspect-${name}`,
              messageId: `inspect-message-${name}`,
            },
          }
        : {}),
      admittedAt: 200,
      admittedEventSeq: 1,
      prompts: ["Use the configured workspace."],
      before: structuredClone(workspace),
      after: structuredClone(workspace),
      selected,
      expected,
      calls,
      exportOperationId: `export-${index}`,
      native: [],
      events: [],
      ...(job
        ? {
            job,
            receipt,
            nativeWrite: {
              jobId: job.jobId,
              executionId: job.execution!.executionId,
              size: firstFile.size,
              sha256: firstFile.sha256,
            },
          }
        : {
            intervention:
              name === "stale-revision"
                ? { kind: "revision" as const, receipt }
                : name === "stale-executor"
                  ? {
                      kind: "executor" as const,
                      target: selected,
                      receipt: {
                        operationId: "revoke",
                        revocationId: "revocation",
                        state: "complete",
                        pendingRecipients: [],
                      },
                    }
                  : {
                      kind: "expiry" as const,
                      expiresAt: 150,
                      credential: { credentialId: "client", generation: 1, grantVersion: 1 },
                    },
          }),
    };
  });
  const roleNames = [
    "writer",
    "peer-a",
    "peer-b",
    ...selectionCases.flatMap((name) => [`${name}-client`, `${name}-export`]),
  ];
  const history = {
    schemaVersion: 1 as const,
    mode: "performed" as const,
    sourceCommit: current.sourceCommit,
    candidateSha256: current.candidateSha256,
    reviewedTarget: target,
    executorIds: ids,
    phases,
    cases,
    cleanup: {
      schemaVersion: 1 as const,
      state: "complete" as const,
      roles: roleNames.map((name) => ({ name, state: "complete" as const })),
      jobs: [],
      stages: [],
      executors: [],
      admissions: cases.flatMap((proof) =>
        (proof.inspectAdmission
          ? ["inspect" as const, "dispatch" as const]
          : ["dispatch" as const]
        ).map((turn) => ({
          name: proof.name,
          turn,
          clientRequestId: `${proof.name}-${turn}`,
          state: "complete" as const,
          task: {
            ...proof.task,
            taskId: turn === "inspect" ? proof.inspectAdmission!.taskId : proof.admission.taskId,
          },
        })),
      ),
      finalDeployment: current,
    },
  };
  const data: SelectionAcceptanceData = {
    history,
    observation: {
      providerDeploymentId: current.deploymentId,
      workerVersionId: current.workerVersionId,
      casesSha256: sha256(canonicalJson(cases)),
      checkedAt: current.checkedAt,
      cases: cases.map((c) => ({ name: c.name })),
    },
    observedDeployment: current,
    initial: device.references.initial,
    cleanup: device.references.cleanup,
  };
  assertSelectionAcceptanceData(data, current);
  return { data, current };
}

test("actual selection sidecar reader accepts its artifact-reference initial field and refuses malformed private transport", async () => {
  const { data, current } = await selectionFixture();
  const root = await realpath(await mkdtemp(resolve(tmpdir(), "fortipi-selection-transport-"))),
    out = resolve(root, "child"),
    path = resolve(root, "selection.json");
  await mkdir(out, { mode: 0o700 });
  const save = (value: unknown) => writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  try {
    await save(data);
    assert.equal("deployment" in data.initial, false);
    assert.deepEqual(await readSelectionEvidenceData(path, out, current), data);
    await chmod(path, 0o644);
    await assert.rejects(readSelectionEvidenceData(path, out, current));
    await chmod(path, 0o600);
    const alias = resolve(root, "alias");
    await symlink(path, alias);
    await assert.rejects(readSelectionEvidenceData(alias, out, current));
    await unlink(alias);
    const hard = resolve(root, "hard");
    await link(path, hard);
    await assert.rejects(readSelectionEvidenceData(path, out, current));
    await unlink(hard);
    const inside = resolve(out, "inside.json");
    await writeFile(inside, JSON.stringify(data), { mode: 0o600 });
    await assert.rejects(readSelectionEvidenceData(inside, out, current));
    await save({ ...data, observedDeployment: { ...current, sourceCommit: "f".repeat(40) } });
    await assert.rejects(readSelectionEvidenceData(path, out, current));
    for (const bytes of [Buffer.from("{"), Buffer.from([0xff]), Buffer.alloc(1048577)]) {
      await writeFile(path, bytes);
      await assert.rejects(readSelectionEvidenceData(path, out, current));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("device CLI data is bounded private metadata outside output, without symlink/hardlink or authority substitution", async () => {
  const { data, current } = await metadataFixture();
  const root = await realpath(await mkdtemp(resolve(tmpdir(), "fortipi-device-transport-")));
  const out = resolve(root, "child"),
    path = resolve(root, "child.devices.json");
  await mkdir(out, { mode: 0o700 });
  const save = (value: unknown) => writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  try {
    await save(data);
    assert.deepEqual(await readDeviceEvidenceData(path, out, current), data);
    const args = [
      "live",
      "--candidate",
      "candidate.json",
      "--fixture",
      "fixture.json",
      "--out",
      out,
      "--devices",
      path,
    ];
    assert.equal(argumentsFor(args).devicesReceipt, path);
    assert.throws(() => argumentsFor([...args.slice(0, -1), "relative.json"]));
    assert.throws(() => argumentsFor(["local", ...args.slice(1)]));
    assert.throws(() => argumentsFor([...args, "--devices", path]));
    await chmod(path, 0o644);
    await assert.rejects(() => readDeviceEvidenceData(path, out, current));
    await chmod(path, 0o600);
    const alias = resolve(root, "alias.json");
    await symlink(path, alias);
    await assert.rejects(() => readDeviceEvidenceData(alias, out, current));
    await unlink(alias);
    const hard = resolve(root, "hard.json");
    await link(path, hard);
    await assert.rejects(() => readDeviceEvidenceData(path, out, current));
    await unlink(hard);
    const inside = resolve(out, "devices.json");
    await writeFile(inside, JSON.stringify(data), { mode: 0o600 });
    await assert.rejects(() => readDeviceEvidenceData(inside, out, current));
    await save({ ...data, authenticated: true });
    await assert.rejects(() => readDeviceEvidenceData(path, out, current));
    const invalidDeployment = structuredClone(data);
    invalidDeployment.initial.deployment.versions = [];
    await save(invalidDeployment);
    await assert.rejects(() => readDeviceEvidenceData(path, out, current));
    const pending = structuredClone(data);
    const firstCleanup = pending.cleanup[0];
    assert.ok(firstCleanup);
    firstCleanup.receipt = {
      operationId: "pending",
      revocationId: "pending",
      state: "pending",
      pendingRecipients: [{ kind: "workspace", id: "workspace" }],
    };
    await save(pending);
    await assert.rejects(() => readDeviceEvidenceData(path, out, current));
    await writeFile(path, Buffer.alloc(1048577), { mode: 0o600 });
    await assert.rejects(() => readDeviceEvidenceData(path, out, current));
    await writeFile(path, "{", { mode: 0o600 });
    await assert.rejects(() => readDeviceEvidenceData(path, out, current));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("actual runner recovery predicate requires the complete Free set including devices before provider operation", async () => {
  const { current } = await metadataFixture();
  const source = await readFile(new URL("./run-evidence.ts", import.meta.url), "utf8");
  const start = source.indexOf("      const ready ="),
    end = source.indexOf("      if (recovery", start);
  assert.ok(start >= 0 && end > start);
  const ready = new Function(
    "recoveryContext",
    "results",
    "identity",
    "liveRecoveryReady",
    `${source.slice(start, end)}\nreturn ready;`,
  );
  // Independent approved non-recovery Free obligations, not a count assertion.
  const rows = [
    "ordinary-tools",
    "selection-acceptance",
    "ticket-grants-revoke",
    "workspace-atomicity",
    "fence-generation",
    "dispatch-safety",
    "approval-reconcile",
    "cloud-local-portability",
    "models-security",
    "public-clients",
    "infrastructure-boundaries",
  ].map((id) => ({ id, outcome: "pass" as const }));
  const check = (items: readonly { id: string; outcome: string }[], target = current) =>
    ready({}, items, { deployments: [target] }, liveRecoveryReady);
  assert.equal(check(rows), true);
  assert.equal(check(rows.filter((row) => row.id !== "ordinary-tools")), false);
  assert.equal(check(rows.filter((row) => row.id !== "selection-acceptance")), false);
  assert.equal(check([...rows, { id: "live-execution-role-cleanup", outcome: "fail" }]), false);
  for (const outcome of ["fail", "unavailable", "timeout"])
    assert.equal(
      check(rows.map((row) => (row.id === "ordinary-tools" ? { ...row, outcome } : row))),
      false,
    );
  for (const outcome of ["fail", "unavailable", "timeout"])
    assert.equal(
      check(rows.map((row) => (row.id === "selection-acceptance" ? { ...row, outcome } : row))),
      false,
    );
  assert.equal(
    check(rows.filter((row) => row.id !== "cloud-local-portability")),
    false,
    "All observed rows may pass while devices are missing",
  );
  assert.equal(check(rows.filter((row) => row.id !== "infrastructure-boundaries")), false);
  assert.equal(
    check(
      rows.map((row) =>
        row.id === "cloud-local-portability" ? { ...row, outcome: "unavailable" } : row,
      ),
    ),
    false,
  );
  const first = rows[0];
  assert.ok(first);
  assert.equal(check([...rows, first]), false);
  assert.equal(
    check([
      ...rows,
      { id: "platform-recovery", outcome: "unavailable" },
      { id: "pi-lifecycle", outcome: "unavailable" },
    ]),
    true,
  );
  const paid: DeploymentIdentity = {
    ...current,
    backend: "cloud-js",
    capabilities: { plan: "paid", loaders: true, containers: false },
  };
  assert.equal(
    check(rows, paid),
    false,
    "A synthetic Paid target still requires its actual tool row; no scope waiver",
  );
  assert.equal(check([...rows, { id: "real-cloud-tools", outcome: "pass" }], paid), true);
});
