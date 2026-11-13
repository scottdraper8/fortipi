import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { provision } from "../../apps/worker/test/integration/fixture-state.ts";
import {
  admissionRecovery,
  concurrentAdmissionBoundary,
  lifecycleRecovery,
} from "../../apps/worker/test/integration/oracles.ts";
import {
  replayLiveRace,
  retainedReplayBounds,
  storedHistoryLifecycle,
} from "../../apps/worker/test/integration/replay-scenarios.ts";
import { start } from "../../apps/worker/test/integration/runtime.ts";
import {
  fenceGeneration,
  interruptedRevocation,
  ticketsAndRevoke,
} from "../../apps/worker/test/integration/tickets-revoke.ts";
import { workspaceAtomicBytes } from "../../apps/worker/test/integration/workspace-portability.ts";
import { loadCandidate } from "../../scripts/prepare-release.ts";
import {
  assertDeployment,
  freshness,
  object,
  readJson,
  regularBytes,
  sha256,
  string,
} from "../../scripts/verify-release-gates.ts";
import { type Installed, install } from "../distribution/install.ts";
import { compatibilityReview, imageSourceReview, supplyReview } from "../distribution/review.ts";
import { keyboardConversationTui, keyboardTui, smokeTui } from "../pty/installed-tui.ts";
import { browser, liveBrowserPort } from "./browser.ts";
import { localBrowser } from "./browser-local.ts";
import {
  type ClaimResult,
  type DecisionClientPort,
  type EvidenceInput,
  evidenceProducer,
  type Identity,
  releaseSet,
  type ScenarioEvidence,
  writeEvidence,
} from "./evidence.ts";
import { liveContext } from "./live.ts";
import { runNativeDaemon } from "./native-daemon.ts";
import { nativePlatform } from "./native-matrix.ts";
import { publicFlow } from "./public-flow.ts";
import { pythonCreation } from "./python.ts";
import { type CleanupObservation, RoleContext } from "./roles.ts";

export type { ClaimResult, EvidenceInput } from "./evidence.ts";

const repository = resolve(import.meta.dirname, "../..");
/** No import-time I/O or test registration. Owner9 calls exactly this coordinator. */
export async function runEvidence(input: EvidenceInput): Promise<ClaimResult[]> {
  assert.ok(["local", "native", "live"].includes(input.mode));
  const fixture = resolve(input.fixture);
  assert.ok(
    fixture.startsWith(`${resolve(repository, "tests/clients/fixtures")}${sep}`) &&
      fixture.endsWith(".json"),
  );
  assert.deepEqual(
    JSON.parse((await regularBytes(fixture)).toString()),
    { schemaVersion: 1, mode: "local", seed: 1010 },
    "Use the full deterministic NONSECRET fixture; dispatch cannot select fewer claims",
  );
  const manifest = object(await readJson(resolve(repository, "package.json")));
  assert.equal(
    process.versions.node,
    string(object(object(manifest.fortipi).toolchain).node),
    "Verified exact Node toolchain required",
  );
  const loaded = await loadCandidate(input.candidateManifest);
  const git = async (...args: string[]) =>
    (await promisify(execFile)("git", args, { cwd: repository })).stdout.trim();
  const sha = await git("rev-parse", "HEAD");
  assert.equal(sha, loaded.candidate.sourceCommit, "Evidence source and candidate must match");
  assert.equal(
    await git("status", "--porcelain"),
    "",
    "Evidence must run from frozen clean source",
  );
  if (loaded.candidate.scope === "fortipi-ci-test")
    assert.equal(loaded.candidate.publishable, false);
  const producer = await evidenceProducer(input, loaded.candidate);
  const identity: Identity = {
    sourceCommit: sha,
    candidateSha256: loaded.hash,
    assetManifestSha256: loaded.candidate.assetManifestSha256,
    platform: process.platform,
    imageBuiltManifestDigest: loaded.candidate.image.builtManifestDigest,
    lockSha256: loaded.candidate.hashes.lock,
    toolchainPolicySha256: loaded.candidate.hashes.toolchainPolicy,
    fixtureSha256: sha256(await regularBytes(fixture)),
    producer,
    architecture: process.arch,
    node: process.versions.node,
    seed: 1010,
    deployments: [],
  };
  if (input.mode === "live") {
    assert.ok(input.deploymentReceipt, "Actual validated deployment receipt required");
    const deployment = await readJson(input.deploymentReceipt);
    assertDeployment(deployment);
    assert.equal(deployment.sourceCommit, sha);
    assert.equal(deployment.candidateSha256, loaded.hash);
    assert.equal(deployment.assetManifestSha256, loaded.candidate.assetManifestSha256);
    freshness(deployment.checkedAt, 0.25);
    assert.equal(new URL(deployment.origin).protocol, "https:");
    identity.deployments.push(deployment);
  } else
    assert.equal(
      input.deploymentReceipt,
      undefined,
      "Source/native evidence cannot borrow a deployment identity",
    );
  await mkdir(dirname(resolve(input.out)), { mode: 0o700, recursive: true });
  await mkdir(resolve(input.out), { mode: 0o700 });
  const results: ClaimResult[] = [];
  const cleanup: CleanupObservation[] = [];
  const command = [
    process.execPath,
    resolve(import.meta.dirname, "run-evidence.ts"),
    input.mode,
    "--candidate",
    resolve(input.candidateManifest),
    "--fixture",
    fixture,
    "--out",
    resolve(input.out),
    ...(input.deploymentReceipt ? ["--deployment", resolve(input.deploymentReceipt)] : []),
  ];
  const invocation =
    process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.dirname, "run-evidence.ts")
      ? "actual-cli"
      : "equivalent-cli-for-exported-runEvidence";
  async function measure(
    id: string,
    scenarioPorts: string[],
    oracle: string,
    scenario: () => Promise<Record<string, unknown>>,
    limitations: string[],
    sensitivity: string[] = [],
  ) {
    const began = performance.now();
    try {
      const observation = await scenario();
      results.push({
        id,
        outcome: "pass",
        identity,
        command,
        observation: {
          ...observation,
          scenarioPorts,
          invocation,
          durationMs: Math.round(performance.now() - began),
        },
        oracle,
        limitations,
        sensitivity,
      });
    } catch (error) {
      // Arbitrary library diagnostics may include request bodies/roles. Preserve
      // sanitized failure metadata, never stringify the thrown object/stack.
      results.push({
        id,
        outcome: error instanceof Error && error.name === "TimeoutError" ? "timeout" : "fail",
        identity,
        command,
        observation: {
          scenarioPorts,
          invocation,
          errorClass: error instanceof Error ? error.name : "UnknownFailure",
          durationMs: Math.round(performance.now() - began),
        },
        oracle,
        limitations,
        sensitivity,
      });
    }
    process.stderr.write(`${id}: ${results.at(-1)!.outcome}\n`);
  }
  let installed: Installed | undefined;
  await measure(
    "distribution-install",
    ["installed-five-packs", "strict-imports", "prepare", "deploy", "--dry-run"],
    "Every retained archive installs independently and together outside checkout with exact reviewed SRI/exports/bins; installed actual Worker dry-build succeeds",
    async () => {
      installed = await install(input.candidateManifest);
      return installed.observation;
    },
    [
      "Synthetic scope registry is installation evidence, not npm rights or publication eligibility",
    ],
  );
  if (input.mode === "local") {
    const localLimits = [
      "Disposable source fixture composes real PiHarness/workerd/SQLite with faux model and acknowledged barriers",
      "Process death proves local disk recovery, not platform eviction; synthetic traffic headroom is not actual Free account capacity",
    ];
    await measure(
      "supply-chain",
      ["supplyReview"],
      "Retained exact archive/SRI/license facts and both reviewed locks match the candidate's source policies and unresolved advisories remain blocking",
      () => supplyReview(input.candidateManifest),
      [
        "Recorded exact graph review is time-bound; no publication provenance or future security clearance",
      ],
    );
    await measure(
      "compatibility-review",
      ["compatibilityReview"],
      "Every maintained watch source is reviewed and unchanged at the retained observation; current pin values match exactly",
      () => compatibilityReview(input.candidateManifest),
      ["A later upstream change requires normal review; no moving-main adoption"],
    );
    await measure(
      "image-security",
      ["imageSourceReview", "verifySourceKit"],
      "Actual retained image metadata, source archive, signed runtime/source/security inputs, SEA and legal source kit reproduce its immutable identity",
      () => imageSourceReview(input.candidateManifest),
      [
        "Source/security-input verification only; actual Linux image runtime proof remains separately authenticated",
      ],
    );
    await measure(
      "measurement-sensitivity",
      ["runSensitivity", "baseline-mutant-restored", "seed1010"],
      "Each required single-site disposable fault reaches its independent behavioral falsifier and the restored producer passes at unchanged source bytes",
      async () => {
        const port = (await import(
          pathToFileURL(resolve(repository, "apps/worker/test/integration/sensitivity.ts")).href
        )) as {
          runSensitivity(
            candidate: string,
            out: string,
          ): Promise<{ id: string; outcome: string }[]>;
        };
        const mutations = await port.runSensitivity(
          input.candidateManifest,
          resolve(input.out, "sensitivity"),
        );
        assert.deepEqual(
          mutations.map((row) => row.id).sort(),
          [
            "admission-identity",
            "canonical-bytes-before-cas",
            "completed-generation",
            "start-ledger-dedup",
            "final-admission-reservation",
          ].sort(),
        );
        assert.ok(
          mutations.every((row) => row.outcome === "killed"),
          "Survived, unreached or unavailable mutation blocks the sensitivity claim",
        );
        return {
          mutations,
          detailedObservations: "sensitivity/sensitivity.json",
          candidateSourceUntouched: true,
        };
      },
      [
        "Disposable local faults measure these oracles, never live production; compiler failure or timeout is not a behavioral kill",
        "Approved falsifier4 scope is real Ledger-to-OS component boundary with separate full-runtime1/1/1 control; scheduler, authority, local/Computer journals, recovery and network are omitted from that component claim",
      ],
    );
    await measure(
      "admission-durability",
      ["admissionRecovery", "seed1010"],
      "One supported actual Pi input and original receipt survive both submit boundaries and same-storage SIGKILL/reopen",
      admissionRecovery,
      localLimits,
    );
    await measure(
      "pi-lifecycle",
      ["lifecycleRecovery", "seed1010"],
      "One durable running task resumes through actual Pi lifecycle after death and completes with unchanged identity",
      lifecycleRecovery,
      localLimits,
    );
    await measure(
      "infrastructure-boundaries",
      ["concurrentAdmissionBoundary", "workspacePolicyBoundaries", "seed1010"],
      "Last-slot concurrency admits one original Pi input; public file/snapshot/manifest below/at/above allocations preserve published bytes on refusal",
      async () => {
        const port = (await import(
          pathToFileURL(resolve(repository, "apps/worker/test/integration/policy-boundaries.ts"))
            .href
        )) as {
          workspacePolicyBoundaries(): Promise<Record<string, unknown>>;
        };
        return {
          admissions: await concurrentAdmissionBoundary(),
          workspaceAllocations: await port.workspacePolicyBoundaries(),
        };
      },
      [
        ...localLimits,
        "Configured allocation boundaries do not prove shared Free account headroom; event/output/reclamation controls are companion observations",
      ],
    );
    await measure(
      "application-replay",
      ["storedHistoryLifecycle", "retainedReplayBounds", "seed1010"],
      "Original committed envelopes survive actual Pi compaction/reset, fork and reopen; expired and future cursor outcomes stay distinct",
      async () => ({
        history: await storedHistoryLifecycle(),
        bounds: await retainedReplayBounds(),
      }),
      localLimits,
    );
    await measure(
      "replay-live-race",
      ["replayLiveRace", "seed1010"],
      "A committed task between captured actual HTTP replay high-water and native live attachment arrives once, in original order",
      replayLiveRace,
      localLimits,
    );
    await measure(
      "ticket-grants-revoke",
      ["ticketsAndRevoke", "interruptedRevocation", "seed1010"],
      "One-use native upgrades reject reuse/expiry/audience, active access closes on actual revoke, and durable pending fanout survives death",
      async () => ({
        tickets: await ticketsAndRevoke(),
        interruptedFanout: await interruptedRevocation(),
      }),
      localLimits,
    );
    await measure(
      "fence-generation",
      ["fenceGeneration", "seed1010"],
      "An actual CP-allowed and already-authenticated call cannot pass after the recipient commits its generation invalidation",
      fenceGeneration,
      localLimits,
    );
    await measure(
      "workspace-atomicity",
      ["workspaceAtomicBytes", "seed1010"],
      "Real Computer old/new byte hashes and same receipt survive partial upload, changed digest, stale base and actual commit-response SIGKILL",
      workspaceAtomicBytes,
      [...localLimits, "Verified reclamation/device replacement are separately required claims"],
    );
    await measure(
      "local-apply-receipt",
      ["localApplyReceipt", "rejectedLocalBytes", "seed1010"],
      "Real non-job native apply stays pinned until its original metadata receipt; a lost acknowledgment cannot repeat effects and stale rejected publication preserves actual canonical bytes",
      async () => {
        const port = (await import(
          pathToFileURL(resolve(repository, "apps/worker/test/integration/local-bytes.ts")).href
        )) as {
          localApplyReceipt(): Promise<Record<string, unknown>>;
          rejectedLocalBytes(): Promise<Record<string, unknown>>;
        };
        return {
          acknowledgmentRecovery: await port.localApplyReceipt(),
          staleCanonicalBytes: await port.rejectedLocalBytes(),
        };
      },
      [
        ...localLimits,
        "Native transport loss/reconnect is distinct from process death; actual journals and files are retained",
      ],
      ["canonical-bytes-before-cas"],
    );
    await measure(
      "device-replacement",
      ["deviceReplacement", "seed1010"],
      "Real distinct native roots/SQLite files preserve one conversation and actual Computer R0/R1/R2 bytes after deleting all of A before B materializes its base",
      async () => {
        const port = (await import(
          pathToFileURL(resolve(repository, "apps/worker/test/integration/device-replacement.ts"))
            .href
        )) as {
          deviceReplacement(): Promise<Record<string, unknown>>;
        };
        return port.deviceReplacement();
      },
      [
        ...localLimits,
        "Same host/source runtime APIs; separate live devices and paid JS/Linux remain mandatory companion proofs",
      ],
    );
    await measure(
      "sealed-store-retirement",
      ["storeRetirement", "seed1010"],
      "Real elapsed grace protects an unreferenced Computer child, confirmed deletion reduces physical bytes, and published independent hashes survive",
      async () => {
        const port = (await import(
          pathToFileURL(resolve(repository, "apps/worker/test/integration/storage-lifecycle.ts"))
            .href
        )) as {
          storeRetirement(): Promise<Record<string, unknown>>;
        };
        return port.storeRetirement();
      },
      [
        ...localLimits,
        "Direct authenticated component allocation/retirement uses actual owner/child methods; no live account capacity inference",
      ],
    );
    let tuiObservation: Record<string, unknown> | undefined;
    const execution = (await import(
      pathToFileURL(resolve(repository, "apps/worker/test/integration/execution.ts")).href
    )) as {
      executionDecisions(
        decide?: (port: DecisionClientPort) => Promise<void>,
      ): Promise<Record<string, unknown>>;
    };
    await measure(
      "native-consent-and-receipt",
      ["executionDecisions", "seed1010"],
      "Actual CP remote consent and independent native consent precede one fsynced start; original Pi child/receipt survives repeated assignment",
      () =>
        execution.executionDecisions(
          installed
            ? async ({ role, firstJob, assertRejectedAndSettledWithoutStart }) => {
                const ports = installed!;
                const module = (await import(
                  pathToFileURL(
                    ports.resolveExport(`@${ports.candidate.scope}/fortipi-client/node`),
                  ).href
                )) as typeof import("../../packages/fortipi-client/dist/node.js");
                const client = new module.FortiPiClient({
                  endpoint: role.endpoint,
                  credentials: async () => role.token,
                  allowLoopbackHttp: true,
                });
                const keyboard = await keyboardTui(ports, role, client, {
                  ...firstJob,
                  assertRejectedWithoutProcessStart: assertRejectedAndSettledWithoutStart,
                });
                tuiObservation = { approval: keyboard };
                assert.ok(!JSON.stringify(tuiObservation).includes(role.token));
              }
            : undefined,
        ),
      [...localLimits, "Crash/reconciliation/installed daemon companion remains required"],
    );
    await measure(
      "scoped-relay",
      ["executionDecisions.scopedRelay", "seed1010"],
      "Actual native owner/public relay returns independently hashed file bytes, rejects a write-only reader and reports unavailable on owner loss while conversation state remains readable",
      async () => {
        const row = results.find((value) => value.id === "native-consent-and-receipt");
        assert.equal(row?.outcome, "pass");
        const relay = object(row.observation.scopedRelay);
        assert.equal(relay.actualPublicRead, true);
        assert.equal(relay.writeOnlyReadStatus, 403);
        assert.equal(relay.ownerLossReadStatus, 503);
        assert.equal(relay.conversationAfterOwnerLoss, 200);
        return relay;
      },
      [
        ...localLimits,
        "Same source native owner; no platform eviction or live separate-host inference",
      ],
    );
    const recovery = (await import(
      pathToFileURL(resolve(repository, "apps/worker/test/integration/dispatch-recovery.ts")).href
    )) as {
      dispatchRecovery(): Promise<Record<string, unknown>>;
      approvalReconciliation(): Promise<Record<string, unknown>>;
    };
    await measure(
      "dispatch-safety",
      ["executionDecisions", "dispatchRecovery", "seed1010"],
      "Actual stable Pi child/execution and one fsynced native start survive acknowledged seed, atomic attachment and retained-receipt service death",
      async () => {
        const consent = results.find((row) => row.id === "native-consent-and-receipt");
        assert.equal(consent?.outcome, "pass");
        return { consent: consent.observation, recovery: await recovery.dispatchRecovery() };
      },
      [
        ...localLimits,
        "Reusable real component recovery seam with strengthened fsynced nonce marker; no platform eviction or separate host claim",
      ],
    );
    await measure(
      "approval-reconcile",
      ["executionDecisions", "approvalReconciliation", "seed1010"],
      "Remote/native consent precede effects, actual unknown effects remain uncertain, and an explicitly authorized new job retains its own approval requirement",
      async () => {
        assert.equal(
          results.find((row) => row.id === "native-consent-and-receipt")?.outcome,
          "pass",
        );
        return recovery.approvalReconciliation();
      },
      [
        ...localLimits,
        "Reconciliation preserves the original consumed Pi outcome and quarantine; no blind side-effect retry",
      ],
    );
    const modelsPath = "apps/worker/test/integration/cloud-models.ts";
    try {
      await git("ls-files", "--error-unmatch", modelsPath);
      await regularBytes(resolve(repository, modelsPath));
      const port = (await import(pathToFileURL(resolve(repository, modelsPath)).href)) as {
        runModelsSecurity?: () => Promise<ScenarioEvidence>;
      };
      assert.equal(typeof port.runModelsSecurity, "function");
      let modelEvidence: ScenarioEvidence | undefined;
      await measure(
        "models-security",
        ["runModelsSecurity", "seed1010"],
        "Actual encrypted CP/Pi Models and provider factories preserve auth generations against synthetic protocol peers",
        async () => {
          modelEvidence = await port.runModelsSecurity!();
          return modelEvidence.observation;
        },
        ["Synthetic protocol peers/keys; no external provider/OAuth or live Workers AI acceptance"],
      );
      if (modelEvidence) {
        const row = results.at(-1)!;
        row.oracle = modelEvidence.oracle;
        row.sensitivity = modelEvidence.sensitivity;
        row.limitations = modelEvidence.limitations;
      }
    } catch {
      // Qualified helper is a parent-owned source handoff. Missing source stays
      // a required unavailable row below; no substitute or auto-copy is used.
    }
    if (installed) {
      const ports = installed;
      await measure(
        "installed-tui-pty",
        ["keyboardTui", "keyboardConversationTui", "smokeTui", "seed1010"],
        "Actual installed TUI keys/current cells create/select/send, preserve offline replay and reject a real job with zero starts; normal controller smoke also completes",
        async () => {
          assert.ok(tuiObservation, "Actual seeded-job keyboard decision is required");
          const runtime = await start({ wranglerBin: ports.wranglerBin }),
            roles = new RoleContext(runtime.endpoint, runtime.admin);
          try {
            const state = await provision(runtime, (body) => roles.issue(body));
            const role = {
              endpoint: runtime.endpoint,
              token: state.client.token,
              agentId: state.agent.agentId,
              conversationId: state.conversations[0]!.conversationId,
            };
            const module = (await import(
              pathToFileURL(ports.resolveExport(`@${ports.candidate.scope}/fortipi-client/node`))
                .href
            )) as typeof import("../../packages/fortipi-client/dist/node.js");
            const client = new module.FortiPiClient({
              endpoint: role.endpoint,
              credentials: async () => role.token,
              allowLoopbackHttp: true,
            });
            const keyboard = await keyboardConversationTui(ports, role, client, async (title) => {
              const deadline = Date.now() + 20000;
              let id: string | undefined;
              while (!id && Date.now() < deadline) {
                const page = await roles.call({
                  operationId: "listConversations",
                  path: { agentId: role.agentId },
                  query: { limit: 100 },
                  body: undefined,
                });
                const created = page.items.filter((conversation) => conversation.title === title);
                assert.ok(
                  created.length <= 1,
                  "One keyboard creation cannot create duplicate conversations",
                );
                id = created[0]?.conversationId;
                if (!id) await new Promise<void>((accept) => setTimeout(accept, 50));
              }
              assert.ok(
                id,
                "Actual public keyboard-created conversation must exist before a role can cover it",
              );
              const replacement = await roles.issue({
                requestId: crypto.randomUUID(),
                role: "client",
                grants: [
                  {
                    grantId: crypto.randomUUID(),
                    version: 1,
                    resources: {
                      ...state.clientResources,
                      conversationIds: [...state.clientResources.conversationIds, id],
                    },
                  },
                ],
              });
              return { ...role, token: replacement.token, conversationId: id };
            });
            const observation = { ...tuiObservation, keyboard, smoke: await smokeTui(ports, role) };
            roles.assertSanitized(observation);
            return observation;
          } finally {
            cleanup.push(...(await roles.cleanup()));
            await runtime.dispose();
          }
        },
        [
          ...localLimits,
          "Separate real plain-response and seeded-tool fixtures; no model/scheduler replacement or action injection",
          "New conversation gets an explicit exact scoped role before reopen; no wildcard authority; necessary synthetic client file removed/revoked",
        ],
      );
      await measure(
        "installed-node-client",
        ["publicFlow", "installed-node-export", "seed1010"],
        "Actual retained public Node client preserves task-correlated committed messages, original receipts and exact offline replay on the actual service",
        async () => {
          const runtime = await start({ wranglerBin: ports.wranglerBin });
          const roles = new RoleContext(runtime.endpoint, runtime.admin);
          try {
            const state = await provision(runtime, (body) => roles.issue(body));
            const module = (await import(
              pathToFileURL(ports.resolveExport(`@${ports.candidate.scope}/fortipi-client/node`))
                .href
            )) as typeof import("../../packages/fortipi-client/dist/node.js");
            const client = () =>
              new module.FortiPiClient({
                endpoint: runtime.endpoint,
                credentials: async () => state.client.token,
                allowLoopbackHttp: true,
              });
            const observed = await publicFlow(client(), client(), {
              agentId: state.agent.agentId,
              conversationId: state.conversations[0]!.conversationId,
              seed: 1010,
            });
            roles.assertSanitized(observed);
            return observed;
          } finally {
            cleanup.push(...(await roles.cleanup()));
            await runtime.dispose();
          }
        },
        [
          "Synthetic source model; actual installed public client and real TCP/workerd/SQLite; no live-provider inference",
        ],
      );
      await measure(
        "installed-browser",
        ["Chromium", "installed-browser-export", "seed1010"],
        "Native browser fetch/ticket WebSocket applies correlated committed completion and exact offline replay",
        () => localBrowser(ports),
        [
          "Local source model fixture; no live provider or account capacity claim",
          "Disposable fixture CA is trusted only by dedicated Node children; Chromium exact leaf-SPKI exception substitutes certificate authentication, not public PKI/hostname/revocation proof",
        ],
      );
      await measure(
        "independent-python",
        ["python3", "-I", "-B", "examples/python-client/client.py"],
        "Independent stdlib implementation negotiates actual service, retains idempotent receipt and applies durable offline resume",
        async () => {
          const runtime = await start({ wranglerBin: ports.wranglerBin });
          const roles = new RoleContext(runtime.endpoint, runtime.admin);
          try {
            const state = await provision(runtime, (body) => roles.issue(body));
            const observation = await pythonCreation(
              {
                endpoint: runtime.endpoint,
                token: state.client.token,
                agentId: state.agent.agentId,
                conversationId: state.conversations[1]!.conversationId,
              },
              async (id) => {
                const role = await roles.issue({
                  requestId: crypto.randomUUID(),
                  role: "client",
                  grants: [
                    {
                      grantId: crypto.randomUUID(),
                      version: 1,
                      resources: { ...state.clientResources, conversationIds: [id] },
                    },
                  ],
                });
                return {
                  endpoint: runtime.endpoint,
                  token: role.token,
                  agentId: state.agent.agentId,
                  conversationId: id,
                };
              },
            );
            roles.assertSanitized(observation);
            return observation;
          } finally {
            cleanup.push(...(await roles.cleanup()));
            await runtime.dispose();
          }
        },
        ["Local actual service, synthetic model; wire-peer negatives are separately classified"],
      );
      await installed.verifyUnchanged();
      await measure(
        "public-clients",
        ["installed-node-client", "installed-browser", "installed-tui-pty", "independent-python"],
        "All four genuine installed/native/independent client observations agree with the same public committed-task and replay contract",
        async () => {
          const clients = [
            "installed-node-client",
            "installed-browser",
            "installed-tui-pty",
            "independent-python",
          ].map((id) => results.find((row) => row.id === id));
          assert.ok(
            clients.every((row) => row?.outcome === "pass"),
            "A missing or failed actual client cannot be inferred from another client",
          );
          return {
            clients: clients.map((row) => ({ id: row!.id, observation: row!.observation })),
          };
        },
        [
          "Local actual service with synthetic model; deployed clients require their own actual deployment identity",
        ],
      );
    }
  }
  if (input.mode === "native" && installed) {
    const ports = installed;
    await measure(
      "portable-daemon-platform",
      ["installed-executor", "native-platform", process.platform],
      "Actual native OS enforces protected roots, no link/traversal escape, SQLite single-daemon exclusion, shell argv and descendant termination",
      () => nativePlatform(ports),
      [
        "Only the current actual OS is measured; no substitution for another native runner",
        "Daemon authority/consent/output/dedup/recovery companion remains required",
      ],
    );
    await measure(
      "portable-daemon",
      ["nativePlatform", "runNativeDaemon", process.platform],
      "Actual current-OS installed executor enforces native protections, exact remote/local consent, confinement refusal, single daemon, bounded readable output and retained execution after abrupt reopen",
      async () => {
        const platform = results.find((row) => row.id === "portable-daemon-platform");
        assert.equal(platform?.outcome, "pass");
        const daemon = await runNativeDaemon(ports);
        return { platform: platform.observation, daemon };
      },
      [
        "Raw receipt uses portable-daemon and this actual OS; owner9 authenticates/aggregates three independent native jobs",
        "Local real service/synthetic model; no substitute for live separate devices or paid backend proof",
      ],
    );
    await installed.verifyUnchanged();
  }
  if (input.mode === "live" && installed) {
    const deployment = identity.deployments[0]!;
    // Only the trusted coordinator reads this role; no child environment below
    // inherits it. Parent producer/deployment validation has already succeeded.
    const admin = process.env.FORTIPI_ADMIN_TOKEN;
    assert.ok(admin, "Trusted live coordinator admin role is required");
    const roles = new RoleContext(deployment.origin, admin);
    try {
      let live: Awaited<ReturnType<typeof liveContext>> | undefined;
      await measure(
        "models-security",
        ["liveContext", "workersAi", "seed1010"],
        "Unmodified installed candidate uses a configured available actual Workers AI model and commits a correlated assistant answer plus terminal task",
        async () => {
          live = await liveContext(installed!, deployment, roles);
          return live.workersAi();
        },
        [
          "Actual target/model proof only; synthetic peer checks separately qualify other provider adapters",
          "No external OAuth/subscription or paid backend inference",
        ],
      );
      if (live) {
        const context = live;
        const workspaceLimits: string[] = [],
          workspaceSensitivity: string[] = [];
        await measure(
          "workspace-atomicity",
          ["runLiveWorkspace", "installed-node-export", "public-Computer", "seed1010"],
          "Actual public Computer publication, original receipt retry, independent canonical byte hashes, stale-base and changed-digest rejection, and writer/read-only boundaries preserve the same committed bytes",
          async () => {
            const evidence = await context.workspace();
            workspaceLimits.push(...evidence.limitations);
            workspaceSensitivity.push(...evidence.sensitivity);
            return { ...evidence.observation, qualifiedPortOracle: evidence.oracle };
          },
          workspaceLimits,
          workspaceSensitivity,
        );
        const controlLimits: string[] = [],
          controlSensitivity: string[] = [];
        await measure(
          "live-pending-task-controls",
          ["runLiveTaskControls", "installed-node-export", "public-cancel", "seed1010"],
          "Actual model dispatch waits without assignment; scoped cancellation retains the original conservative receipt and late approval cannot resurrect the cancelled job",
          async () => {
            const evidence = await context.pendingTaskControls();
            controlLimits.push(...evidence.limitations);
            controlSensitivity.push(...evidence.sensitivity);
            return { ...evidence.observation, qualifiedPortOracle: evidence.oracle };
          },
          controlLimits,
          controlSensitivity,
        );
        let access: Record<string, unknown> | undefined;
        await measure(
          "ticket-grants-revoke",
          ["publicAccess", "actual-expiry", "native-ticket-upgrades"],
          "Real default native upgrades enforce one-use/elapsed expiry/audience/scope; public complete revoke closes acknowledged access and rejects fresh work",
          async () => {
            access = await context.access();
            return access;
          },
          [
            "Actual live transport and generation propagation; no controlled production fault endpoint or replacement transport",
          ],
        );
        await measure(
          "fence-generation",
          ["publicAccess.cachedRecipient", "pre-revocation-ticket"],
          "An acknowledged real recipient loses access and an unused previously issued ticket cannot bypass completed credential-generation invalidation",
          async () => {
            assert.ok(access);
            assert.equal(access.cachedRecipientAccessClosed, true);
            assert.equal(access.staleUnusedTicketRejected, true);
            return access;
          },
          [
            "Controlled already-allowed CP call fencing is the separate same-source integrated oracle; live proof observes actual recipient/ticket propagation",
          ],
        );
        await measure(
          "live-installed-node",
          ["publicFlow", "installed-node-export", "seed1010"],
          "Actual installed public Node client preserves receipt/task correlation and canonical offline replay against the deployed service",
          () => context.publicNode(),
          ["Browser/TUI/native-device companion evidence remains required for public-clients"],
        );
        await measure(
          "independent-python",
          ["python3", "-I", "-B", "examples/python-client/client.py"],
          "Independent stdlib client preserves TLS, actual tickets, committed tasks and durable replay on the same deployed contract",
          async () =>
            pythonCreation(await context.publicRole(2, "python"), context.authorizeConversation),
          ["External-provider and paid backend success are separate claims"],
        );
        await measure(
          "installed-tui-smoke",
          ["smokeTui", "installed-bin", "seed1010"],
          "Actual installed TUI controller performs committed send, read controls and offline replay against the unchanged deployed service",
          async () => smokeTui(installed!, await context.publicRole(2, "tui")),
          [
            "Live keyboard/job decision companion remains required; no PTY claim from controller smoke",
          ],
        );
        await measure(
          "live-installed-tui-keyboard",
          ["keyboardConversationTui", "installed-bin", "seed1010"],
          "Actual installed TUI keys create with exact role issuance, select/send and display correlated committed tasks plus offline replay on the unchanged deployed service",
          async () => {
            const role = await context.publicRole(2, "tui");
            return keyboardConversationTui(
              installed!,
              role,
              context.clientForRole(role.token),
              context.authorizeCreated,
            );
          },
          [
            "Live native/cloud job decision and recovery companions remain separately required; no external OAuth or paid backend inference",
          ],
        );
        await measure(
          "live-infrastructure-discovery",
          ["liveContext.infrastructure", "seed1010"],
          "Actual deployed protocol/configuration and authenticated deployment capabilities agree before clients may invoke available backends",
          context.infrastructure,
          [
            "Discovery does not prove account-wide capacity/exhaustion; infrastructure-boundaries remains a separate required live claim",
          ],
        );
        await measure(
          "installed-browser",
          ["Chromium", "installed-browser-export", "seed1010"],
          "Actual browser native CORS/ticket transport preserves committed tasks/replay and acknowledged access is removed on public role revocation",
          async () => {
            const web = await browser(installed!, { port: liveBrowserPort });
            try {
              const role = await context.publicRole(1, "browser");
              return await web.run(
                {
                  endpoint: role.endpoint,
                  token: role.token,
                  agentId: role.agentId,
                  conversationId: role.conversationId,
                  seed: 1010,
                },
                async () => {
                  const receipt = await roles.revokeAndWait(role.credential.credentialId);
                  assert.equal(
                    receipt.state,
                    "complete",
                    "Live browser revocation remains pending; repeat in a fresh evidence run",
                  );
                },
              );
            } finally {
              await web.close();
            }
          },
          [
            "Requires exact https://127.0.0.1:10110 in the target's ordinary browser-origin allowlist; no injected Origin/header or browser transport",
            "Disposable HTTPS page identity uses an exact Chromium leaf-SPKI exception; deployed endpoint remains ordinary public HTTPS",
          ],
        );
        await measure(
          "public-clients",
          [
            "live-installed-node",
            "installed-browser",
            "installed-tui-smoke",
            "live-installed-tui-keyboard",
            "independent-python",
          ],
          "All actual installed/independent clients preserve committed task correlation and offline replay on this unchanged deployed identity",
          async () => {
            const ids = [
              "live-installed-node",
              "installed-browser",
              "installed-tui-smoke",
              "live-installed-tui-keyboard",
              "independent-python",
            ];
            const clients = ids.map((id) => results.find((row) => row.id === id));
            assert.ok(clients.every((row) => row?.outcome === "pass"));
            return {
              clients: clients.map((row) => ({ id: row!.id, observation: row!.observation })),
            };
          },
          [
            "Live backend/native decisions, platform recovery, separate devices and real account limits remain independent required claims",
          ],
        );
      }
      assert.equal(
        (
          await roles.call({
            operationId: "getConfiguration",
            path: {},
            query: {},
            body: undefined,
          })
        ).version,
        deployment.publicConfigurationVersion,
        "Live target configuration changed during evidence",
      );
      for (const row of results) roles.assertSanitized(row);
    } finally {
      cleanup.push(...(await roles.cleanup()));
    }
  }
  if (cleanup.length)
    results.push({
      id: "ephemeral-role-cleanup",
      outcome: cleanup.every((r) => r.state === "complete") ? "pass" : "fail",
      identity,
      command,
      observation: { roles: cleanup, invocation, scenarioPorts: ["RoleContext.cleanup"] },
      oracle:
        "Every issued ephemeral role is publicly revoked; pending recipients/unknown disposition block acceptance",
      sensitivity: [],
      limitations: [],
    });
  // Every required but unobserved claim is explicit and blocking. Scenario ports
  // are added here as implemented; a partial source checkpoint never earns gate.json.
  for (const id of releaseSet(input.mode, identity.deployments))
    if (!results.some((r) => r.id === id))
      results.push({
        id,
        outcome: "unavailable",
        identity,
        command,
        observation: { requiredEvidenceObserved: false, invocation },
        oracle:
          "Approved thread10 requires actual observed behavior and its applicable sensitivity; missing rows cannot be waived",
        sensitivity: [],
        limitations: [
          "Required composed scenario/native job/live capability evidence is not yet available at this source checkpoint",
        ],
      });
  assert.equal((await loadCandidate(input.candidateManifest)).hash, loaded.hash);
  assert.equal(await git("status", "--porcelain"), "", "Evidence changed frozen source");
  assert.deepEqual(await evidenceProducer(input, loaded.candidate), producer);
  await writeEvidence(input, loaded.candidate, identity, results);
  return results;
}
function argumentsFor(argv: string[]): EvidenceInput {
  const [mode, ...args] = argv;
  assert.ok(
    mode === "local" || mode === "native" || mode === "live",
    "Expected local, native or live",
  );
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i],
      value = args[i + 1];
    assert.ok(
      key &&
        ["--candidate", "--fixture", "--out", "--deployment"].includes(key) &&
        value &&
        !values.has(key),
      "Invalid or duplicate evidence argument",
    );
    values.set(key, value);
  }
  const candidateManifest = values.get("--candidate"),
    fixture = values.get("--fixture"),
    out = values.get("--out");
  assert.ok(candidateManifest && fixture && out, "Candidate, fixture and output are required");
  return {
    mode,
    candidateManifest: resolve(candidateManifest),
    fixture: resolve(fixture),
    out: resolve(out),
    ...(values.has("--deployment")
      ? { deploymentReceipt: resolve(values.get("--deployment")!) }
      : {}),
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void Promise.resolve()
    .then(() => runEvidence(argumentsFor(process.argv.slice(2))))
    .then((rows) => {
      process.stdout.write(
        `${JSON.stringify({
          claims: rows.length,
          passed: rows.filter((r) => r.outcome === "pass").length,
          complete: rows.length > 0 && rows.every((r) => r.outcome === "pass"),
        })}\n`,
      );
      if (!rows.length || rows.some((r) => r.outcome !== "pass")) process.exitCode = 1;
    })
    .catch(() => {
      process.stderr.write(
        "Required evidence input/scenario/identity unavailable or invalid; no acceptance.\n",
      );
      process.exitCode = 1;
    });
}
