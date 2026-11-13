import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { parse } from "@babel/parser";
import { build } from "esbuild";
import { loadCandidate } from "../../../../scripts/prepare-release.ts";
import { provision } from "./fixture-state.ts";
import { rejectedLocalBytes } from "./local-bytes.ts";
import { concurrentAdmissionBoundary } from "./oracles.ts";
import { poll, start } from "./runtime.ts";
import {
  runStartLedgerSensitivity,
  type StartLedgerSensitivity,
} from "./start-ledger-sensitivity.ts";
import { fenceGeneration } from "./tickets-revoke.ts";

const repository = resolve(import.meta.dirname, "../../../..");
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
type Kind =
  | "admission-identity"
  | "canonical-bytes-before-cas"
  | "completed-generation"
  | "start-ledger-dedup"
  | "final-admission-reservation";
export type MutationResult = WorkerMutationResult | StartLedgerSensitivity;
export interface WorkerMutationResult {
  id: Kind;
  outcome: "killed" | "survived" | "unavailable";
  source?: string;
  sourceSha256?: string;
  patchSha256?: string;
  baseline?: Record<string, unknown>;
  mutant?: Record<string, unknown>;
  restored?: Record<string, unknown>;
  limitation?: string;
}
type Ast = { type: string; start?: number | null; end?: number | null; [key: string]: unknown };
function walk(value: unknown, visit: (node: Ast, parents: Ast[]) => void, parents: Ast[] = []) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const child of value) walk(child, visit, parents);
    return;
  }
  const node = value as Ast;
  if (typeof node.type !== "string") return;
  visit(node, parents);
  for (const [key, child] of Object.entries(node))
    if (
      ![
        "loc",
        "tokens",
        "comments",
        "leadingComments",
        "trailingComments",
        "innerComments",
      ].includes(key)
    )
      walk(child, visit, [...parents, node]);
}
function member(value: unknown, object: string, property: string): boolean {
  const node = value as Ast | undefined;
  return (
    node?.type === "MemberExpression" &&
    (node.object as Ast)?.type === "Identifier" &&
    (node.object as Ast).name === object &&
    (node.property as Ast)?.type === "Identifier" &&
    (node.property as Ast).name === property
  );
}
function patch(kind: Kind, source: string) {
  const ast = parse(source, { sourceType: "module", plugins: ["typescript"] });
  const matches: Ast[] = [];
  walk(ast, (node, parents) => {
    if (
      kind === "completed-generation" &&
      node.type === "BinaryExpression" &&
      node.operator === ">=" &&
      member(node.left, "ctx", "generation") &&
      source.slice(node.start!, node.end!).includes('"credential-floor"')
    )
      matches.push(node);
    if (
      kind === "final-admission-reservation" &&
      node.type === "BinaryExpression" &&
      node.operator === "<=" &&
      source.slice(node.start!, node.end!).replaceAll(/\s/g, "") ===
        "totals.slots+input.admissionSlots<=policy.bounds.activeMutatingJobs"
    )
      matches.push(node);
    if (
      kind === "admission-identity" &&
      member(node, "body", "clientRequestId") &&
      parents.some(
        (parent) => parent.type === "VariableDeclarator" && (parent.id as Ast)?.name === "key",
      ) &&
      parents.some(
        (parent) => parent.type === "ClassMethod" && (parent.key as Ast)?.name === "submit",
      )
    )
      matches.push(node);
    if (
      kind === "canonical-bytes-before-cas" &&
      node.type === "ExpressionStatement" &&
      source.slice(node.start!, node.end!) ===
        "await this.current(row.observation.preManifestHash);" &&
      parents.some(
        (parent) => parent.type === "ClassMethod" && (parent.key as Ast)?.name === "apply",
      )
    )
      matches.push(node);
  });
  assert.equal(matches.length, 1, "A sensitivity patch must match exactly one reviewed AST site");
  const target = matches[0]!;
  assert.ok(typeof target.start === "number" && typeof target.end === "number");
  const replacement =
    kind === "admission-identity"
      ? "crypto.randomUUID()"
      : kind === "canonical-bytes-before-cas"
        ? `{
      // Disposable ordering regression: capture the real old state, write real
      // staged bytes, and only then enforce the captured stale-base decision.
      const prematureBefore = await scan(this.root, this.limits);
      const prematureStage = this.staging.get(row.request);
      for (const mutation of prematureStage.mutations) if (mutation.kind === "put")
        await this.root.write(mutation.entry.path, await this.staging.bytes(mutation.blob), mutation.entry.mode);
      if (prematureBefore.manifestHash !== row.observation.preManifestHash)
        throw new Error("workspace.conflict: local_drift");
    }`
        : "true";
  const descriptor = {
    kind,
    start: target.start,
    end: target.end,
    before: source.slice(target.start, target.end),
    replacement,
  };
  return {
    modified: source.slice(0, target.start) + replacement + source.slice(target.end),
    descriptor,
  };
}
async function compile(directory: string, kind: Kind, fault: boolean) {
  const source =
    kind === "admission-identity"
      ? "apps/worker/src/agent/conversations.ts"
      : kind === "canonical-bytes-before-cas"
        ? "packages/fortipi-executor/src/workspace/local.ts"
        : kind === "completed-generation"
          ? "apps/worker/src/agent/authority.ts"
          : "apps/worker/src/control/capacity.ts";
  const original = await readFile(resolve(repository, source), "utf8"),
    mutation = patch(kind, original);
  const native = kind === "canonical-bytes-before-cas";
  const outfile = resolve(
    directory,
    `${kind}-${fault ? "mutant" : "baseline"}.${native ? "mjs" : "js"}`,
  );
  let loaded = 0;
  const result = await build({
    entryPoints: [
      resolve(repository, native ? source : "apps/worker/test/integration/fixture-worker.ts"),
    ],
    outfile,
    bundle: true,
    format: "esm",
    platform: native ? "node" : "neutral",
    target: "es2024",
    mainFields: native ? ["module", "main"] : ["browser", "module", "main"],
    conditions: native ? ["node"] : ["workerd", "worker", "browser"],
    external: ["cloudflare:*", "node:*", ...builtinModules],
    ...(native
      ? {
          banner: {
            js: `import {createRequire as __createRequire} from 'node:module';const require=__createRequire(${JSON.stringify(resolve(repository, "package.json"))});`,
          },
        }
      : {}),
    loader: { ".yaml": "json" },
    logLevel: "silent",
    metafile: true,
    plugins: [
      {
        name: "one-reviewed-source-fault",
        setup(builder) {
          builder.onLoad({ filter: /\.ts$/ }, async (args) => {
            if (resolve(args.path) !== resolve(repository, source)) return undefined;
            loaded++;
            return { contents: fault ? mutation.modified : original, loader: "ts" };
          });
        },
      },
    ],
  });
  assert.equal(loaded, 1);
  assert.ok(
    Object.keys(result.metafile.inputs).some(
      (path) => resolve(path) === resolve(repository, source),
    ),
  );
  return {
    outfile,
    source,
    sourceSha256: sha(original),
    patchSha256: sha(JSON.stringify(mutation.descriptor)),
    outputSha256: sha(await readFile(outfile)),
  };
}
async function admissionMultiplicity(main: string) {
  const runtime = await start({ main });
  try {
    const state = await provision(runtime),
      cid = state.conversations[0]!.conversationId;
    const probe = `/__test/agents/${state.agent.agentId}`;
    const body = {
      clientRequestId: crypto.randomUUID(),
      content: "seed1010-sensitivity-input",
      busyBehavior: "followUp",
    };
    await runtime.api(`${probe}/fault`, "after-submit");
    const lost = runtime
      .api(`/v1/conversations/${cid}/messages`, body, "POST", state.client.token)
      .catch(() => undefined);
    await runtime.barrier(state.agent.agentId, "after-submit");
    await runtime.stopAbruptly();
    await lost;
    await runtime.reopenSameStorage();
    const recovered = await poll(
      async () =>
        (
          await runtime.api<{ admissions: { taskId: string; receipt: unknown }[] }>(
            `${probe}/state`,
          )
        ).body,
      (value) => value.admissions.some((admission) => !!admission.receipt),
    );
    const originalTask = recovered.admissions.find((admission) => !!admission.receipt)!.taskId;
    await poll(
      async () =>
        (
          await runtime.api<{ status: { state: string } }>(
            `/v1/tasks/${originalTask}`,
            undefined,
            "GET",
            state.client.token,
          )
        ).body,
      (value) => value.status.state === "completed",
    );
    const reply = await runtime.api<{ taskId: string }>(
      `/v1/conversations/${cid}/messages`,
      body,
      "POST",
      state.client.token,
    );
    assert.equal(reply.status, 202, "Original accepted identity must remain retryable");
    await poll(
      async () =>
        (
          await runtime.api<{ status: { state: string } }>(
            `/v1/tasks/${reply.body.taskId}`,
            undefined,
            "GET",
            state.client.token,
          )
        ).body,
      (value) => value.status.state === "completed",
    );
    const inspection = await poll(
      async () =>
        (
          await runtime.api<{ entries: { kind: string; text: string }[] }>(
            `${probe}/inspect?cid=${cid}`,
          )
        ).body,
      (value) => value.entries.some((entry) => entry.kind === "pi.user"),
    );
    const count = inspection.entries.filter(
      (entry) => entry.kind === "pi.user" && entry.text === body.content,
    ).length;
    assert.equal(
      count,
      1,
      "Stable admission must retain one actual Pi input across a lost accepted response",
    );
    assert.equal(
      reply.body.taskId,
      originalTask,
      "Retry must return the original accepted task identity",
    );
    return {
      actualPiInputs: count,
      repeatedAdmissionStatus: reply.status,
      originalTaskRetained: true,
      acknowledgedActualSubmitBoundary: true,
    };
  } finally {
    await runtime.dispose();
  }
}
async function scenario(kind: Kind, main: string) {
  if (kind === "canonical-bytes-before-cas") {
    const module = (await import(pathToFileURL(main).href)) as {
      LocalWorkspace: typeof import("../../../../packages/fortipi-executor/dist/index.js").LocalWorkspace;
    };
    return rejectedLocalBytes(module.LocalWorkspace);
  }
  if (kind === "completed-generation") return fenceGeneration({ main });
  if (kind === "admission-identity") return admissionMultiplicity(main);
  return concurrentAdmissionBoundary({ main });
}
function falsifier(kind: Kind, error: unknown): Record<string, unknown> | undefined {
  if (!(error instanceof assert.AssertionError)) return;
  if (
    kind === "completed-generation" &&
    error.actual === 200 &&
    error.expected === 403 &&
    error.message.includes("already-authenticated")
  )
    return {
      actualStaleOperationStatus: 200,
      requiredStatus: 403,
      actualAllowedDecisionBarrierReached: true,
    };
  if (
    kind === "admission-identity" &&
    typeof error.actual === "number" &&
    error.actual > 1 &&
    error.expected === 1 &&
    error.message.includes("one actual Pi input")
  )
    return {
      duplicateActualPiInputs: error.actual,
      requiredInputs: 1,
      actualAcceptedSubmitBarrierReached: true,
    };
  if (
    kind === "final-admission-reservation" &&
    error.actual === 2 &&
    error.expected === 1 &&
    error.message.includes("final Free slot")
  )
    return {
      actualAcceptedContenders: 2,
      availableSlots: 1,
      actualConcurrentRequestsReachedReservation: true,
    };
  if (
    kind === "canonical-bytes-before-cas" &&
    error.message.includes("Rejected stale canonical CAS") &&
    typeof error.actual === "string" &&
    typeof error.expected === "string" &&
    /^[a-f0-9]{64}$/.test(error.actual) &&
    /^[a-f0-9]{64}$/.test(error.expected) &&
    error.actual !== error.expected
  )
    return {
      canonicalHashBefore: error.expected,
      canonicalHashAfter: error.actual,
      rejectedActualStaleOperation: true,
    };
}
export async function exerciseMutation(kind: Kind): Promise<MutationResult> {
  if (kind === "start-ledger-dedup")
    // Preserve the qualified component scope and the separately protected full
    // runtime observations verbatim; this is not a full-runtime kill claim.
    return runStartLedgerSensitivity();
  const directory = await mkdtemp(resolve(tmpdir(), "fortipi-thread10-mutant-"));
  try {
    const baseline = await compile(directory, kind, false);
    const before = await scenario(kind, baseline.outfile);
    const mutant = await compile(directory, kind, true);
    assert.notEqual(mutant.outputSha256, baseline.outputSha256);
    let observed: Record<string, unknown> | undefined, nonBehavioralFailure: string | undefined;
    let assertion: Record<string, unknown> | undefined;
    try {
      await scenario(kind, mutant.outfile);
    } catch (error) {
      observed = falsifier(kind, error);
      if (!observed) {
        nonBehavioralFailure = error instanceof Error ? error.name : "UnknownFailure";
        if (
          error instanceof assert.AssertionError &&
          typeof error.actual === "number" &&
          typeof error.expected === "number"
        )
          assertion = { actual: error.actual, expected: error.expected };
      }
    }
    const restored = await compile(directory, kind, false);
    assert.equal(
      restored.outputSha256,
      baseline.outputSha256,
      "Restored producer must reproduce the original binary input",
    );
    const after = await scenario(kind, restored.outfile);
    assert.equal(
      sha(await readFile(resolve(repository, baseline.source))),
      baseline.sourceSha256,
      "Release source must remain untouched",
    );
    return {
      id: kind,
      outcome: observed ? "killed" : nonBehavioralFailure ? "unavailable" : "survived",
      source: baseline.source,
      sourceSha256: baseline.sourceSha256,
      patchSha256: mutant.patchSha256,
      baseline: { ...before, producerSha256: baseline.outputSha256 },
      mutant: {
        ...(observed ?? {
          requiredBehavioralFalsifierObserved: false,
          ...(nonBehavioralFailure ? { nonBehavioralFailure, ...assertion } : {}),
        }),
        producerSha256: mutant.outputSha256,
      },
      restored: { ...after, producerSha256: restored.outputSha256 },
    };
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}
export async function runSensitivity(candidate: string, out: string): Promise<MutationResult[]> {
  const loaded = await loadCandidate(candidate);
  const git = async (...args: string[]) =>
    (await promisify(execFile)("git", args, { cwd: repository })).stdout.trim();
  assert.equal(await git("rev-parse", "HEAD"), loaded.candidate.sourceCommit);
  assert.equal(
    await git("status", "--porcelain"),
    "",
    "Candidate sensitivity requires frozen clean source",
  );
  const results: MutationResult[] = [];
  for (const kind of [
    "admission-identity",
    "canonical-bytes-before-cas",
    "completed-generation",
    "start-ledger-dedup",
    "final-admission-reservation",
  ] as const) {
    const result = await exerciseMutation(kind);
    results.push(result);
    process.stderr.write(`sensitivity ${kind}: ${result.outcome}\n`);
  }
  assert.equal(await git("status", "--porcelain"), "", "Sensitivity changed frozen source");
  await mkdir(out, { recursive: true, mode: 0o700 });
  await writeFile(
    resolve(out, "sensitivity.json"),
    `${JSON.stringify({ sourceCommit: loaded.candidate.sourceCommit, candidateSha256: loaded.hash, results }, null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
  return results;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2),
    at = (flag: string) => args[args.indexOf(flag) + 1];
  void Promise.resolve()
    .then(async () => {
      const candidate = at("--candidate"),
        out = at("--out");
      assert.ok(candidate && out);
      const results = await runSensitivity(resolve(candidate), resolve(out));
      if (results.length !== 5 || results.some((result) => result.outcome !== "killed"))
        process.exitCode = 1;
    })
    .catch(() => {
      process.stderr.write(
        "Sensitivity failed or did not reach its required behavioral falsifier; no acceptance.\n",
      );
      process.exitCode = 1;
    });
}
