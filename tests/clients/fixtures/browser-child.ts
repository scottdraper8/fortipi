import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { provision } from "../../../apps/worker/test/integration/fixture-state.ts";
import { start } from "../../../apps/worker/test/integration/runtime.ts";
import { readInstalledClientSnapshot } from "../../distribution/consumer-runtime.ts";
import { browser } from "../browser.ts";
import { type FixtureTLS, verifyFixtureTLS } from "../fixture-tls.ts";
import {
  type BrowserDiagnostic,
  browserFailure,
  projectBrowserDiagnostic,
} from "../local-evidence-observation.ts";
import { RoleContext } from "../roles.ts";

export async function browserChild(argv: string[]) {
  let stage = "inputs";
  let browserDiagnostic: BrowserDiagnostic | undefined;
  let runtime: Awaited<ReturnType<typeof start>> | undefined,
    web: Awaited<ReturnType<typeof browser>> | undefined;
  let roles: RoleContext | undefined;
  let observation: Record<string, unknown> | undefined,
    failure:
      | {
          stage: string;
          errorClass: string;
          errorCode?: string;
          cleanupComplete?: boolean;
          diagnostic?: BrowserDiagnostic;
        }
      | undefined;
  let closing: Promise<Awaited<ReturnType<RoleContext["cleanup"]>> | undefined> =
    Promise.resolve(undefined);
  let cleanupComplete = true;
  let cleanupStage = "public-role-cleanup";
  const cleanupFailure = (at: string, errorClass = "CleanupFailure") => {
    cleanupComplete = false;
    failure ??= { stage: at, errorClass };
  };
  const close = () => {
    closing = closing
      .catch(() => cleanupFailure(cleanupStage))
      .then(async () => {
        cleanupStage = "public-role-cleanup";
        let cleanup: Awaited<ReturnType<RoleContext["cleanup"]>> | undefined;
        // Retain roles: setup may register another receipt after an earlier signal pass.
        try {
          cleanup = await roles?.cleanup();
          if (cleanup?.some((role) => role.state !== "complete"))
            cleanupFailure("public-role-cleanup", "IncompleteRevocation");
        } catch {
          cleanupFailure("public-role-cleanup");
        }
        cleanupStage = "browser-cleanup";
        const browser = web;
        web = undefined;
        try {
          await browser?.close();
        } catch {
          cleanupFailure("browser-cleanup");
        }
        cleanupStage = "browser-runtime-cleanup";
        const server = runtime;
        runtime = undefined;
        try {
          await server?.dispose();
        } catch {
          cleanupFailure("browser-runtime-cleanup");
        }
        return cleanup;
      });
    return closing;
  };
  const stop = () => {
    void close().catch(() => {});
  };
  process.once("SIGTERM", stop);
  try {
    assert.equal(argv.length, 3);
    const [metadata, expected, description] = argv;
    assert.ok(metadata && expected && description);
    assert.equal(
      Object.hasOwn(process.env, "GITHUB_TOKEN"),
      false,
      "Application fixture inherited GitHub authority",
    );
    const ports = await readInstalledClientSnapshot(metadata, expected);
    const tls = JSON.parse(await readFile(description, "utf8")) as FixtureTLS;
    assert.equal(process.env.NODE_EXTRA_CA_CERTS, tls.ca);
    assert.equal((await verifyFixtureTLS(tls)).leafSpki, tls.leafSpki);
    stage = "serve-https-origins";
    web = await browser(ports, { tls });
    stage = "start-real-wrangler-https";
    runtime = await start({
      allowedOrigin: web.origin,
      wranglerBin: ports.wranglerBin,
      tls,
      traffic: "free",
    });
    roles = new RoleContext(runtime.endpoint, runtime.admin);
    stage = "public-provision";
    const state = await provision(runtime, (input) => roles!.issue(input));
    const witness = await roles.issueBrowserRevocation(
      state.agent.agentId,
      state.conversations[0]!.conversationId,
    );
    assert.ok(
      witness.credential.credentialId !== state.client.credential.credentialId,
      "Revocation witness must be an independently issued principal",
    );
    stage = "chromium-public-flow-cors-revoke";
    observation = await web.run(
      {
        endpoint: runtime.endpoint,
        token: state.client.token,
        agentId: state.agent.agentId,
        conversationId: state.conversations[0]!.conversationId,
        seed: 1010,
      },
      {
        input: {
          endpoint: roles.endpoint,
          token: witness.token,
          agentId: state.agent.agentId,
          conversationId: state.conversations[0]!.conversationId,
          seed: 1010,
        },
        revoke: async () => {
          const receipt = await roles!.revokeAndWait(witness.credential.credentialId);
          assert.equal(receipt.state, "complete");
        },
      },
      (value, diagnostic) => {
        stage = value;
        browserDiagnostic =
          diagnostic === undefined ? undefined : projectBrowserDiagnostic(diagnostic);
      },
    );
    stage = "browser-postchecks";
    browserDiagnostic = undefined;
    roles.assertSanitized(observation);
    const protocol = await runtime.api<{
      infrastructure: {
        bounds: { requestsPerPrincipalMinute: number; requestsPerInstallMinute: number };
      };
    }>("/v1/protocol");
    assert.equal(protocol.body.infrastructure.bounds.requestsPerPrincipalMinute, 30);
    assert.equal(protocol.body.infrastructure.bounds.requestsPerInstallMinute, 120);
    observation.traffic = {
      defaultConfiguredFreeIngress: true,
      requestsPerPrincipalMinute: protocol.body.infrastructure.bounds.requestsPerPrincipalMinute,
      requestsPerInstallMinute: protocol.body.infrastructure.bounds.requestsPerInstallMinute,
      actualFreeAccountProof: false,
    };
    await ports.verifyUnchanged();
  } catch (error) {
    failure = {
      stage,
      ...browserFailure(error),
      ...(browserDiagnostic ? { diagnostic: browserDiagnostic } : {}),
    };
  } finally {
    // Seal signal admissions before joining the final serialized cleanup pass.
    process.off("SIGTERM", stop);
    try {
      const cleanup = await close();
      if (!cleanupComplete) {
        failure ??= { stage: cleanupStage, errorClass: "CleanupFailure" };
        failure.cleanupComplete = false;
      }
      if (observation) observation.cleanup = cleanup;
    } catch {
      failure ??= { stage: cleanupStage, errorClass: "CleanupFailure" };
      failure.cleanupComplete = false;
    }
  }
  return failure
    ? { outcome: "fail", ...failure }
    : { outcome: "pass", stage: "complete", observation };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void browserChild(process.argv.slice(2))
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result)}\n`);
      if (result.outcome !== "pass") process.exitCode = 1;
    })
    .catch(() => {
      process.stdout.write('{"outcome":"fail","stage":"cleanup","errorClass":"CleanupFailure"}\n');
      process.exitCode = 1;
    });
}
