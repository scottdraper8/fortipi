import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { provision } from "../../../apps/worker/test/integration/fixture-state.ts";
import { start } from "../../../apps/worker/test/integration/runtime.ts";
import { readInstalledClientSnapshot } from "../../distribution/consumer-runtime.ts";
import { browser } from "../browser.ts";
import { type FixtureTLS, verifyFixtureTLS } from "../fixture-tls.ts";
import { RoleContext } from "../roles.ts";

export async function browserChild(argv: string[]) {
  let stage = "inputs";
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
          diagnostic?: Record<string, unknown>;
        }
      | undefined;
  let closing: Promise<Awaited<ReturnType<RoleContext["cleanup"]>> | undefined> | undefined;
  const close = () => {
    closing ??= (async () => {
      const cleanup = await roles?.cleanup();
      await web?.close();
      await runtime?.dispose();
      return cleanup;
    })();
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
    stage = "chromium-public-flow-cors-revoke";
    observation = await web.run(
      {
        endpoint: runtime.endpoint,
        token: state.client.token,
        agentId: state.agent.agentId,
        conversationId: state.conversations[0]!.conversationId,
        seed: 1010,
      },
      async () => {
        const receipt = await roles!.revokeAndWait(state.client.credential.credentialId);
        assert.equal(receipt.state, "complete");
      },
      (value) => {
        stage = value;
      },
    );
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
    const known =
      error instanceof Error
        ? error.message.match(
            /\b(?:quota_exceeded|quota_paused|rate_limited|unauthorized|unauthenticated|handshake_failed|smoke_deadline)\b/,
          )?.[0]
        : undefined;
    const diagnostic = (error as { diagnostic?: Record<string, unknown> })?.diagnostic;
    failure = {
      stage,
      errorClass: error instanceof Error ? error.name : "UnknownFailure",
      ...(known ? { errorCode: known } : {}),
      ...(diagnostic ? { diagnostic } : {}),
    };
  } finally {
    const cleanup = await close();
    process.off("SIGTERM", stop);
    if (cleanup?.some((role) => role.state !== "complete")) {
      failure ??= { stage: "public-role-cleanup", errorClass: "IncompleteRevocation" };
      failure.cleanupComplete = false;
    }
    if (observation) observation.cleanup = cleanup;
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
