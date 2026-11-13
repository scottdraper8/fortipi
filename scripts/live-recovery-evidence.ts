import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { verifyPrepared } from "../packages/fortipi-cli/dist/assets.js";
import type { WranglerPort } from "../packages/fortipi-cli/dist/wrangler.js";
import type { ApplicationRecoveryBridge } from "../tests/clients/platform-recovery.ts";
import { validateApplicationRecoveryCheckpoints } from "./application-recovery-checkpoints.ts";
import {
  type ApplicationRecoveryProof,
  applicationRecoveryProofFile,
  createApplicationRecoveryCoordinator,
} from "./application-recovery-coordinator.ts";
import { createExistingApplicationRecoveryCoordinator } from "./application-recovery-existing.ts";
import { repository } from "./build-workspaces.ts";
import { assertTarget, cloudflareRequest, observeDeployment } from "./deploy-smoke.ts";
import type { ProviderPhaseResult } from "./platform-recovery.ts";
import { evidenceProducer, loadWorkflowCandidate, runEvidence } from "./prepare-release.ts";
import {
  assertDeployment,
  assertGate,
  type CandidateManifest,
  canonicalJson,
  type DeploymentIdentity,
  dispatchEnvironment,
  freshness,
  type GitHubRequest,
  githubRequest,
  integer,
  object,
  privilegedCheckout,
  REPOSITORY,
  REPOSITORY_ID,
  readJson,
  readProofBundle,
  regularBytes,
  saveJson,
  sha256,
  string,
  trustedMain,
  verifyPayload,
} from "./verify-release-gates.ts";

export interface LiveRecoveryEvidenceInput {
  candidatePath: string;
  installationPath: string;
  fixture: string;
  out: string;
  deploymentPath: string;
  proofsPath: string;
}
export interface LiveRecoveryEvidenceResult {
  currentReceiptPath: string;
  recoveryFactsPath: string;
}
const stable = ({ checkedAt: _time, ...value }: DeploymentIdentity) => value;
const maximum = 1_048_576;
function snapshot<T>(value: T): T {
  return JSON.parse(canonicalJson(value));
}
function within(root: string, path: string) {
  const local = relative(root, path);
  assert.ok(local && !isAbsolute(local) && local !== ".." && !local.startsWith(`..${sep}`));
}
async function canonicalFile(path: string, limit = maximum) {
  const bytes = await regularBytes(path, limit);
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  assert.equal(bytes.toString("utf8"), `${canonicalJson(value)}\n`);
  return { bytes, value };
}

/** Import only the authenticated, readonly installed closure, never checkout Wrangler. */
async function installedWrangler(
  installed: Record<string, unknown>,
  candidate: CandidateManifest,
): Promise<WranglerPort> {
  const consumer = string(installed.consumer);
  assert.equal(await realpath(consumer), consumer);
  assert.ok(!consumer.startsWith(`${repository}${sep}`) && consumer !== repository);
  const verifyPackage = async (sourceName: "fortipi-cli" | "fortipi-contract") => {
    const root = await realpath(
      resolve(consumer, "node_modules", `@${candidate.scope}/${sourceName}`),
    );
    within(resolve(consumer, "node_modules"), root);
    for (let parent = root; parent !== consumer; parent = dirname(parent)) {
      const stat = await lstat(parent);
      assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
      assert.equal(stat.mode & 0o222, 0);
    }
    const pkg = candidate.packages.filter((row) => row.sourceName === sourceName);
    assert.equal(pkg.length, 1);
    const entries = pkg[0]?.entries;
    assert.ok(entries);
    for (const file of entries) {
      const path = resolve(root, file.path);
      within(root, path);
      const stat = await lstat(path);
      assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1);
      assert.equal(stat.mode & 0o222, 0);
      assert.equal(Boolean(stat.mode & 0o111), Boolean(file.mode & 0o111));
      assert.equal(stat.size, file.size);
      assert.equal(sha256(await regularBytes(path, file.size)), file.sha256);
    }
    return { root, entries };
  };
  // Wrangler imports profiles/config, which imports this separate public package.
  await verifyPackage("fortipi-contract");
  const { root, entries } = await verifyPackage("fortipi-cli");
  const entry = resolve(root, "dist/wrangler.js");
  assert.ok(entries.some((file) => file.path === "dist/wrangler.js"));
  assert.equal(await realpath(string(installed.cliBin)), resolve(root, "dist/bin.js"));
  const port = (await import(pathToFileURL(entry).href)) as {
    wrangler: WranglerPort;
    wranglerBin(): Promise<string>;
  };
  assert.equal(typeof port.wrangler?.run, "function");
  const bin = await port.wranglerBin(); // Existing exact Node/Wrangler pin guard.
  within(root, bin);
  assert.ok(entries.some((file) => resolve(root, file.path) === bin));
  return port.wrangler;
}

/** Verify the actual current operate attempt, source bytes and main before any CF use. */
async function authorize(candidate: CandidateManifest, request: GitHubRequest) {
  assert.equal(process.env.GITHUB_ACTIONS, "true");
  await dispatchEnvironment();
  assert.ok(process.env.OPERATION === "deploy" || process.env.OPERATION === "verify");
  assert.equal(process.env.SOURCE_SHA, candidate.sourceCommit);
  assert.equal(process.env.RELEASE_VERSION, candidate.version);
  assert.equal(process.env.RELEASE_SCOPE, candidate.scope);
  assert.equal(process.env.EXPECTED_TAG, candidate.tag);
  await privilegedCheckout(candidate);
  await trustedMain(candidate, request);
  const producer = await evidenceProducer(repository, candidate, "live", request);
  assert.equal(producer.workflowPath, ".github/workflows/deploy.yml");
  const base = `/repos/${REPOSITORY}`;
  for (const path of [
    `${base}/actions/runs/${producer.runId}`,
    `${base}/actions/runs/${producer.runId}/attempts/${producer.runAttempt}`,
  ]) {
    const run = object(await request(path));
    assert.equal(run.id, producer.runId);
    assert.equal(run.run_attempt, producer.runAttempt);
    assert.equal(run.workflow_id, producer.workflowId);
    assert.equal(run.head_sha, candidate.sourceCommit);
    assert.equal(run.head_branch, "main");
    assert.equal(run.event, "workflow_dispatch");
    assert.equal(run.status, "in_progress");
    assert.equal(run.conclusion, null);
    assert.equal(object(run.repository).id, REPOSITORY_ID);
    assert.equal(object(run.head_repository).id, REPOSITORY_ID);
    assert.equal(string(run.path).split("@")[0], producer.workflowPath);
    freshness(string(run.updated_at), 6);
  }
  const content = object(
    await request(`${base}/contents/${producer.workflowPath}?ref=${candidate.sourceCommit}`),
  );
  assert.equal(content.encoding, "base64");
  assert.ok(typeof content.content === "string");
  assert.equal(
    sha256(Buffer.from(content.content.replaceAll("\n", ""), "base64")),
    producer.workflowSha256,
  );
  const jobs: Record<string, unknown>[] = [];
  let total = Infinity;
  for (let page = 1; jobs.length < total; page++) {
    assert.ok(page <= 20);
    const response = object(
      await request(
        `${base}/actions/runs/${producer.runId}/attempts/${producer.runAttempt}/jobs?per_page=100&page=${page}`,
      ),
    );
    total = integer(response.total_count);
    assert.ok(Array.isArray(response.jobs) && response.jobs.length > 0);
    jobs.push(...response.jobs.map(object));
  }
  const matching = jobs.filter((job) => job.name === "operate");
  assert.equal(matching.length, 1);
  const job = matching[0];
  assert.ok(job);
  assert.equal(job.run_id, producer.runId);
  assert.equal(job.head_sha, candidate.sourceCommit);
  assert.equal(job.status, "in_progress");
  assert.equal(job.conclusion, null);
  freshness(string(job.started_at), 6);
}

/** Trusted outer process only. Ordinary evidence children receive the existing
 * filtered environment and private IPC bridge, never provider capabilities. */
export async function runLiveRecoveryEvidence(
  input: LiveRecoveryEvidenceInput,
): Promise<LiveRecoveryEvidenceResult> {
  try {
    const bound = snapshot(input);
    assert.deepEqual(Object.keys(bound).sort(), [
      "candidatePath",
      "deploymentPath",
      "fixture",
      "installationPath",
      "out",
      "proofsPath",
    ]);
    for (const path of Object.values(bound)) assert.ok(isAbsolute(path) && resolve(path) === path);
    for (const path of [
      bound.deploymentPath,
      `${bound.deploymentPath}.provider-version.json`,
      `${bound.deploymentPath}.recovery-current.json`,
    ])
      assert.ok(path !== bound.out && !path.startsWith(`${bound.out}${sep}`));
    const request = githubRequest(process.env.GITHUB_TOKEN);
    const loaded = await loadWorkflowCandidate(bound.candidatePath);
    await authorize(loaded.candidate, request);
    const operation = process.env.OPERATION;
    const installed = object((await canonicalFile(bound.installationPath)).value);
    assert.equal(installed.schemaVersion, 1);
    assert.equal(installed.candidatePath, bound.candidatePath);
    assert.equal(installed.candidateSha256, loaded.hash);
    const target = installed.target;
    assertTarget(target);
    const prepared = string(installed.prepared);
    assert.equal(await realpath(prepared), prepared);
    const fixture = resolve(repository, "tests/clients/fixtures/local.json");
    assert.equal(bound.fixture, fixture);
    assert.deepEqual(await readJson(fixture), { schemaVersion: 1, mode: "local", seed: 1010 });
    const original = await canonicalFile(bound.deploymentPath);
    assertDeployment(original.value);
    const before = original.value;
    assert.equal(before.candidateSha256, loaded.hash);
    assert.equal(before.sourceCommit, loaded.candidate.sourceCommit);
    assert.equal(before.accountBindingSha256, target.accountBindingSha256);
    assert.equal(before.backend, target.backend);
    assert.equal(before.slot, target.slot ?? "production");
    const deployment = object(object(target.operator).deployment);
    assert.equal(before.workerName, deployment.name);
    assert.equal(before.origin, deployment.origin);
    freshness(before.checkedAt, 0.25);
    const cli = await canonicalFile(`${bound.deploymentPath}.cli.json`);
    const receipt = object(cli.value);
    assert.deepEqual(Object.keys(receipt).sort(), [
      "assetManifestSha256",
      "configSha256",
      "origin",
      "packageVersion",
      "sourceCommit",
      "targets",
      "workerName",
      "workerVersionId",
    ]);
    assert.equal(receipt.workerVersionId, before.workerVersionId);
    assert.equal(receipt.workerName, before.workerName);
    assert.equal(receipt.origin, before.origin);
    assert.equal(receipt.sourceCommit, loaded.candidate.sourceCommit);
    assert.equal(receipt.packageVersion, loaded.candidate.version);
    assert.equal(receipt.assetManifestSha256, loaded.candidate.assetManifestSha256);
    assert.equal(receipt.configSha256, sha256(canonicalJson(object(target.operator).runtime)));
    assert.ok(
      Array.isArray(receipt.targets) &&
        receipt.targets.length === 1 &&
        (receipt.targets[0] === before.origin || `https://${receipt.targets[0]}` === before.origin),
    );
    const preparedReceipt = await verifyPrepared(prepared);
    assert.equal(preparedReceipt.sourceCommit, loaded.candidate.sourceCommit);
    assert.equal(preparedReceipt.assetManifestSha256, loaded.candidate.assetManifestSha256);
    assert.deepEqual(preparedReceipt.operator, target.operator);
    const wrangler = await installedWrangler(installed, loaded.candidate);
    await authorize(loaded.candidate, request);
    assert.equal(process.env.OPERATION, operation);
    // First CF/application credential access, after all source/installation/frame guards.
    const account = process.env.CLOUDFLARE_ACCOUNT_ID;
    const token = process.env.CLOUDFLARE_API_TOKEN;
    const admin = process.env.FORTIPI_ADMIN_TOKEN;
    assert.ok(
      typeof account === "string" &&
        /^[a-f0-9]{32}$/.test(account) &&
        sha256(account) === target.accountBindingSha256,
    );
    assert.ok(typeof token === "string" && token.length > 0);
    assert.ok(typeof admin === "string" && admin.length > 0);
    const factory = async () => {
      await authorize(loaded.candidate, request);
      assert.equal(process.env.OPERATION, operation);
      return {
        read: cloudflareRequest(account, target.accountBindingSha256, token),
        wrangler,
        applicationTransport: fetch,
        applicationAdminToken: admin,
      };
    };
    const observe = async (receipt: unknown) =>
      observeDeployment(
        loaded.candidate,
        loaded.hash,
        target,
        prepared,
        receipt,
        (await factory()).read,
        fetch,
        admin,
      );
    const initial = await observe(cli.value);
    assert.deepEqual(stable(initial), stable(before));
    const checkpointDirectory = resolve(bound.out, "application-recovery");
    const journalDirectory = resolve(bound.out, "provider-recovery");
    const currentReceiptPath = `${bound.deploymentPath}.provider-version.json`;
    const recoveryFactsPath = `${bound.out}.recovery-link.json`;
    const activeObservationPath = `${bound.deploymentPath}.recovery-current.json`;
    const retainOriginals = async () => {
      assert.equal(await realpath(bound.out), bound.out);
      assert.equal((await lstat(bound.out)).mode & 0o777, 0o700);
      await mkdir(journalDirectory, { mode: 0o700, recursive: true });
      assert.equal(await realpath(journalDirectory), journalDirectory);
      assert.equal((await lstat(journalDirectory)).mode & 0o777, 0o700);
      await writeFile(resolve(journalDirectory, "original-deployment.json"), original.bytes, {
        flag: "wx",
        mode: 0o600,
      });
      await writeFile(resolve(journalDirectory, "original-deployment.cli.json"), cli.bytes, {
        flag: "wx",
        mode: 0o600,
      });
    };
    const forbiddenValues = [account, token, admin, process.env.GITHUB_TOKEN ?? ""];
    let current: DeploymentIdentity;
    let linked: Record<string, unknown>;
    let currentReceipt: unknown;
    let childStartupObservation = before;
    if (operation === "deploy") {
      const coordinator = createApplicationRecoveryCoordinator(
        {
          candidatePath: bound.candidatePath,
          candidateSha256: loaded.hash,
          sourceCommit: loaded.candidate.sourceCommit,
          preparedDirectory: prepared,
          target,
          before,
          operationId: randomBytes(16).toString("hex"),
          journalDirectory,
          checkpointDirectory,
        },
        factory,
      );
      let confirmed: Awaited<ReturnType<ApplicationRecoveryBridge["perform"]>> | undefined;
      let qualified: Awaited<ReturnType<ApplicationRecoveryBridge["finish"]>> | undefined;
      const bridge: ApplicationRecoveryBridge = {
        async perform(record) {
          assert.equal(confirmed, undefined);
          await retainOriginals();
          const result = await coordinator.perform(record);
          confirmed = snapshot(result);
          return result;
        },
        async finish(record) {
          assert.equal(qualified, undefined);
          const result = await coordinator.finish(record);
          qualified = snapshot(result);
          return result;
        },
      };
      await runEvidence(
        "live",
        bound.candidatePath,
        bound.fixture,
        bound.out,
        bound.deploymentPath,
        { checkpointDirectory, coordinator: { mode: "perform", bridge }, forbiddenValues },
      );
      assert.ok(confirmed?.status === "operation-confirmed" && qualified?.status === "qualified");
      const proofFile = await canonicalFile(
        resolve(journalDirectory, applicationRecoveryProofFile),
      );
      const proof = proofFile.value as ApplicationRecoveryProof;
      const transitionFile = await canonicalFile(resolve(journalDirectory, "transition.json"));
      const transition = transitionFile.value as ProviderPhaseResult["transition"];
      assert.equal(proof.transitionSha256, qualified.operationEvidenceSha256);
      assert.equal(proof.transitionSha256, confirmed.operationEvidenceSha256);
      assert.equal(proof.transitionSha256, sha256(transitionFile.bytes));
      assert.deepEqual(transition.before, before);
      assert.deepEqual(transition.after, confirmed.after);
      currentReceipt = { ...object(cli.value), workerVersionId: confirmed.after.workerVersionId };
      current = await observe(currentReceipt);
      await validateApplicationRecoveryCheckpoints({
        checkpointDirectory,
        candidateSha256: loaded.hash,
        sourceCommit: loaded.candidate.sourceCommit,
        before: { ...proof.before, path: resolve(bound.out, proof.before.path) },
        after: { ...proof.after, path: resolve(bound.out, proof.after.path) },
        provider: { transition, transitionSha256: proof.transitionSha256, current },
      });
      linked = {
        mode: "perform",
        operationId: proof.operationId,
        transitionSha256: proof.transitionSha256,
        proofSha256: sha256(proofFile.bytes),
        before: proof.before,
        after: proof.after,
        transitionBefore: transition.before,
        transitionAfter: transition.after,
      };
    } else {
      const bundle = await readProofBundle(bound.proofsPath);
      const matches = bundle.proofs.filter(({ receipt }) => {
        const deployment = receipt.deployments[0];
        return (
          Boolean(deployment) &&
          receipt.kind === "live" &&
          receipt.candidateSha256 === loaded.hash &&
          receipt.sourceCommit === loaded.candidate.sourceCommit &&
          receipt.deployments.length === 1 &&
          canonicalJson(stable(deployment as DeploymentIdentity)) === canonicalJson(stable(initial))
        );
      });
      assert.equal(matches.length, 1);
      const proof = matches[0];
      assert.ok(proof);
      const reader = createExistingApplicationRecoveryCoordinator(
        {
          candidatePath: bound.candidatePath,
          candidateSha256: loaded.hash,
          sourceCommit: loaded.candidate.sourceCommit,
          preparedDirectory: prepared,
          target,
          current: initial,
          proof,
          proofsRoot: resolve(dirname(bound.proofsPath), "proofs"),
        },
        request,
        factory,
      );
      try {
        const result = await reader.verifyExisting(); // Exactly once, before the child.
        assert.equal(result.status, "lineage-confirmed");
        if (result.status !== "lineage-confirmed") throw Error("Unavailable");
        current = result.current;
        childStartupObservation = current;
        const checkpointCopies = await Promise.all(
          [result.before, result.after].map(async (record, index) => {
            const bytes = await regularBytes(record.path, maximum);
            assert.equal(bytes.length, record.size);
            assert.equal(sha256(bytes), record.sha256);
            assert.equal((await lstat(record.path)).mode & 0o777, 0o600);
            return {
              bytes,
              record: {
                ...record,
                path: resolve(
                  checkpointDirectory,
                  index === 0 ? "application-before.json" : "application-after.json",
                ),
              },
            };
          }),
        );
        const beforeCopy = checkpointCopies[0]?.record;
        const afterCopy = checkpointCopies[1]?.record;
        assert.ok(beforeCopy && afterCopy);
        const cachedReply = Object.freeze({
          ...result,
          before: Object.freeze(beforeCopy),
          after: Object.freeze(afterCopy),
        });
        const originalProof = await canonicalFile(
          resolve(proof.directory, "claims/provider-recovery", applicationRecoveryProofFile),
        );
        const proofRecord = proof.receipt.files.find(
          (file) => file.path === `claims/provider-recovery/${applicationRecoveryProofFile}`,
        );
        assert.ok(proofRecord);
        assert.equal(proofRecord.sha256, sha256(originalProof.bytes));
        assert.equal(proofRecord.size, originalProof.bytes.length);
        await saveJson(activeObservationPath, current);
        let delivered = false;
        await runEvidence(
          "live",
          bound.candidatePath,
          bound.fixture,
          bound.out,
          activeObservationPath,
          {
            checkpointDirectory,
            coordinator: {
              mode: "verify-existing",
              bridge: {
                verifyExisting: async () => {
                  assert.equal(delivered, false);
                  delivered = true;
                  await retainOriginals();
                  await mkdir(checkpointDirectory, { recursive: true, mode: 0o700 });
                  assert.equal(await realpath(checkpointDirectory), checkpointDirectory);
                  assert.equal((await lstat(checkpointDirectory)).mode & 0o777, 0o700);
                  for (const { bytes, record } of checkpointCopies) {
                    await writeFile(record.path, bytes, { flag: "wx", mode: 0o600 });
                    assert.equal((await lstat(record.path)).mode & 0o777, record.mode);
                    assert.deepEqual(await regularBytes(record.path, maximum), bytes);
                  }
                  return cachedReply;
                },
              },
            },
            forbiddenValues,
          },
        );
        assert.ok(delivered);
        const originalRecord = originalProof.value as ApplicationRecoveryProof;
        linked = {
          mode: "verify-existing",
          evidence: result.evidence,
          operationId: originalRecord.operationId,
          transitionSha256: result.operation.operationEvidenceSha256,
          proofSha256: sha256(originalProof.bytes),
          before: originalRecord.before,
          after: originalRecord.after,
          transitionBefore: result.operation.before,
          transitionAfter: result.operation.after,
        };
        currentReceipt = { ...object(cli.value), workerVersionId: current.workerVersionId };
      } finally {
        await reader.dispose();
      }
    }
    assert.deepEqual(await regularBytes(bound.deploymentPath, maximum), original.bytes);
    assert.deepEqual(await regularBytes(`${bound.deploymentPath}.cli.json`, maximum), cli.bytes);
    const childGate = await canonicalFile(resolve(bound.out, "gate.json"), 8_000_000);
    assertGate(childGate.value);
    assert.equal(childGate.value.kind, "live");
    assert.equal(childGate.value.sourceCommit, loaded.candidate.sourceCommit);
    assert.equal(childGate.value.candidateSha256, loaded.hash);
    assert.deepEqual(childGate.value.deployments, [childStartupObservation]);
    await verifyPayload(bound.out, childGate.value.files, ["gate.json"]);
    await saveJson(currentReceiptPath, currentReceipt);
    if (operation === "deploy") await saveJson(activeObservationPath, current);
    await saveJson(recoveryFactsPath, {
      schemaVersion: 1,
      sourceCommit: loaded.candidate.sourceCommit,
      candidateSha256: loaded.hash,
      original: before,
      childStartupObservation,
      current,
      childGateSha256: sha256(childGate.bytes),
      originalDeploymentSha256: sha256(original.bytes),
      originalCliSha256: sha256(cli.bytes),
      currentReceiptSha256: sha256(`${canonicalJson(currentReceipt)}\n`),
      receiptProvenance: "provider-confirmed-version; not a second CLI invocation",
      ...linked,
    });
    return { currentReceiptPath, recoveryFactsPath };
  } catch {
    throw new Error(
      "Live application recovery evidence unavailable or inconsistent; no claim qualified",
    );
  }
}
