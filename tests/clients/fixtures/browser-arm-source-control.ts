// Intended path: tests/clients/fixtures/browser-arm-source-control.ts.
// Source engineering diagnostic only; never installed/release qualification.
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { start } from "../../../apps/worker/test/integration/runtime.ts";
import type { sourceBrowser } from "../browser.ts";
import type { FixtureTLS } from "../fixture-tls.ts";
import type { BrowserDiagnostic } from "../local-evidence-observation.ts";
import type { RoleContext } from "../roles.ts";

const root = resolve(import.meta.dirname, "../../..");
const output = resolve(root, "dist/source-browser-control.json");
const childMode = process.argv[2] === "--source-child";
let projection: typeof import("../local-evidence-observation.ts");
interface Result {
  sourceCommit: string | null;
  outcome: "pass" | "fail";
  stage: string | null;
  code: number | null;
  timedOut: boolean;
  cleanupComplete: boolean | null;
  errorClass: string | null;
  errorCode: string | null;
  diagnostic: BrowserDiagnostic;
}
function sourceCommit(): string | null {
  const value = process.env.GITHUB_SHA;
  return value?.length === 40 && /^[a-f0-9]{40}$/.test(value) ? value : null;
}
function outerFailure(): Result {
  return {
    sourceCommit: sourceCommit(),
    outcome: "fail",
    stage: "inputs",
    code: null,
    timedOut: false,
    cleanupComplete: null,
    errorClass: "Error",
    errorCode: null,
    diagnostic: { phase: null, code: null, status: null, completionDeadline: null },
  };
}
/** Reuse the maintained closed stage/error/code catalogs; never forward raw objects. */
function project(input: Record<string, unknown>): Result {
  const record = JSON.parse(
    projection.localBrowserLine(
      "report",
      {
        code: input.code,
        timedOut: input.timedOut,
      },
      {
        stage: input.stage,
        cleanupComplete: input.cleanupComplete,
        errorClass: input.errorClass,
        errorCode: input.errorCode,
        diagnostic: projection.projectBrowserDiagnostic(input.diagnostic),
      },
    ),
  );
  return {
    sourceCommit: sourceCommit(),
    outcome:
      input.outcome === "pass" &&
      record.stage === "complete" &&
      record.code === 0 &&
      record.timedOut === false &&
      record.cleanupComplete === true &&
      record.errorClass === null &&
      record.errorCode === null
        ? "pass"
        : "fail",
    stage: record.stage,
    code: record.code,
    timedOut: record.timedOut === true,
    cleanupComplete: record.cleanupComplete,
    errorClass: record.errorClass,
    errorCode: record.errorCode,
    diagnostic: projection.projectBrowserDiagnostic({
      phase: record.publicPhase,
      code: record.publicCode,
      status: record.publicStatus,
      completionDeadline: record.completionDeadline,
    }),
  };
}
function encode(result: Result): string {
  const bytes = `${JSON.stringify(result)}\n`;
  assert.ok(Buffer.byteLength(bytes) <= 8192);
  return bytes;
}

async function child(args: string[]): Promise<Result> {
  let stage = "inputs",
    diagnostic: BrowserDiagnostic | undefined;
  let runtime: Awaited<ReturnType<typeof start>> | undefined;
  let web: Awaited<ReturnType<typeof sourceBrowser>> | undefined;
  let roles: RoleContext | undefined;
  let failure: { stage: string; errorClass: string; errorCode?: string } | undefined;
  let stopping = false,
    cleanupComplete = true,
    closing = Promise.resolve();
  const cleanupFailure = (at: string) => {
    cleanupComplete = false;
    failure ??= { stage: at, errorClass: "CleanupFailure" };
  };
  // Serialize signal/final cleanup and also collect anything acquired after a signal.
  const close = () => {
    closing = closing.then(async () => {
      const authority = roles;
      // cleanup() is uncached; retain ownership so the final pass sees late issue() receipts.
      try {
        if (authority && (await authority.cleanup()).some((row) => row.state !== "complete"))
          cleanupFailure("public-role-cleanup");
      } catch {
        cleanupFailure("public-role-cleanup");
      }
      const browser = web;
      web = undefined;
      try {
        await browser?.close();
      } catch {
        cleanupFailure("browser-cleanup");
      }
      const server = runtime;
      runtime = undefined;
      try {
        await server?.dispose();
      } catch {
        cleanupFailure("browser-runtime-cleanup");
      }
    });
    return closing;
  };
  const stop = () => {
    stopping = true;
    failure ??= { stage, errorClass: "Error" };
    void close().catch(() => cleanupFailure("cleanup"));
  };
  const running = () => {
    if (stopping) throw new Error("Source control stopped");
  };
  process.once("SIGTERM", stop);
  try {
    assert.equal(args.length, 1);
    for (const key of ["GITHUB_TOKEN", "GH_TOKEN", "CLOUDFLARE_API_TOKEN", "NPM_TOKEN"])
      assert.equal(Object.hasOwn(process.env, key), false);
    const [{ sourceBrowser }, { start }, { provision }, { RoleContext }, { verifyFixtureTLS }] =
      await Promise.all([
        import("../browser.ts"),
        import("../../../apps/worker/test/integration/runtime.ts"),
        import("../../../apps/worker/test/integration/fixture-state.ts"),
        import("../roles.ts"),
        import("../fixture-tls.ts"),
      ]);
    const tls = JSON.parse(await readFile(args[0]!, "utf8")) as FixtureTLS;
    assert.equal(process.env.NODE_EXTRA_CA_CERTS, tls.ca);
    assert.equal((await verifyFixtureTLS(tls)).leafSpki, tls.leafSpki);
    running();
    stage = "serve-https-origins";
    const browser = await sourceBrowser({ tls });
    web = browser;
    running();
    stage = "start-real-wrangler-https";
    const server = await start({ allowedOrigin: browser.origin, tls, traffic: "free" });
    runtime = server;
    running();
    const authority = new RoleContext(server.endpoint, server.admin);
    roles = authority;
    stage = "public-provision";
    const state = await provision(server, (input) => authority.issue(input));
    running();
    stage = "chromium-public-flow-cors-revoke";
    const observation = await browser.run(
      {
        endpoint: server.endpoint,
        token: state.client.token,
        agentId: state.agent.agentId,
        conversationId: state.conversations[0]!.conversationId,
        seed: 1010,
      },
      async () => {
        const receipt = await authority.revokeAndWait(state.client.credential.credentialId);
        assert.equal(receipt.state, "complete");
      },
      (value, observed) => {
        stage = value;
        diagnostic =
          observed === undefined ? undefined : projection.projectBrowserDiagnostic(observed);
      },
    );
    running();
    stage = "browser-postchecks";
    diagnostic = undefined;
    authority.assertSanitized(observation);
    assert.equal(observation.sourceBrowserGraph, true);
    assert.equal(observation.installedBrowserGraph, false);
    const protocol = await server.api<{
      infrastructure: {
        bounds: { requestsPerPrincipalMinute: number; requestsPerInstallMinute: number };
      };
    }>("/v1/protocol");
    assert.equal(protocol.body.infrastructure.bounds.requestsPerPrincipalMinute, 30);
    assert.equal(protocol.body.infrastructure.bounds.requestsPerInstallMinute, 120);
  } catch (error) {
    failure ??= { stage, ...projection.browserFailure(error) };
  } finally {
    await close();
    process.off("SIGTERM", stop);
  }
  return project({
    outcome: failure ? "fail" : "pass",
    stage: failure?.stage ?? "complete",
    code: failure ? 1 : 0,
    timedOut: false,
    cleanupComplete,
    errorClass: failure?.errorClass,
    errorCode: failure?.errorCode,
    diagnostic,
  });
}

async function parent(args: string[]): Promise<Result> {
  let tls: FixtureTLS | undefined,
    result = outerFailure();
  try {
    assert.equal(args.length, 0);
    const [{ fixtureTLS }, { browserProcess }, { childEnvironment }, { chromium }] =
      await Promise.all([
        import("../fixture-tls.ts"),
        import("../browser-local.ts"),
        import("../../../scripts/prepare-release.ts"),
        import("playwright"),
      ]);
    tls = await fixtureTLS();
    const description = resolve(tls.directory, "source-control-tls.json");
    await writeFile(description, JSON.stringify(tls), { flag: "wx", mode: 0o600 });
    let revision = chromium.executablePath();
    while (!/^chromium-\d+$/.test(basename(revision))) {
      assert.notEqual(dirname(revision), revision);
      revision = dirname(revision);
    }
    const captured = await browserProcess(
      [resolve(import.meta.filename), "--source-child", description],
      tls.directory,
      childEnvironment({
        XDG_CONFIG_HOME: resolve(tls.directory, "config"),
        XDG_CACHE_HOME: resolve(tls.directory, "cache"),
        LOCALAPPDATA: resolve(tls.directory, "local"),
        APPDATA: resolve(tls.directory, "roaming"),
        NODE_EXTRA_CA_CERTS: tls.ca,
        PLAYWRIGHT_BROWSERS_PATH: dirname(revision),
      }),
    );
    result.code = captured.code;
    result.timedOut = captured.timedOut;
    assert.ok(Buffer.byteLength(captured.stdout) <= 8192);
    const observed: unknown = JSON.parse(captured.stdout);
    assert.ok(observed && typeof observed === "object" && !Array.isArray(observed));
    const closed = project(observed as Record<string, unknown>);
    // Exact closed child shape; unknown fields/values never reach stdout or artifact.
    assert.equal(encode(closed), encode(observed as Result));
    result = project({ ...closed, code: captured.code, timedOut: captured.timedOut });
    if (captured.code !== 0 || captured.timedOut) result.outcome = "fail";
  } catch {
    const fixed = outerFailure();
    fixed.code = result.code;
    fixed.timedOut = result.timedOut;
    result = fixed;
  } finally {
    if (tls)
      try {
        await rm(tls.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      } catch {
        if (result.outcome === "pass")
          result = project({
            outcome: "fail",
            stage: "cleanup",
            code: result.code,
            timedOut: result.timedOut,
            cleanupComplete: false,
            errorClass: "CleanupFailure",
          });
        else result.cleanupComplete = false;
      }
  }
  return result;
}

async function main() {
  let result = outerFailure();
  try {
    projection = await import("../local-evidence-observation.ts");
    result = childMode ? await child(process.argv.slice(3)) : await parent(process.argv.slice(2));
  } catch {
    /* Fixed outer failure only; no raw error forwarding. */
  }
  if (!childMode)
    try {
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, encode(result), { flag: "wx", mode: 0o600, flush: true });
    } catch {
      result = outerFailure();
    }
  process.stdout.write(encode(result));
  if (result.outcome !== "pass") process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch(() => {
    process.stdout.write(encode(outerFailure()));
    process.exitCode = 1;
  });
}
