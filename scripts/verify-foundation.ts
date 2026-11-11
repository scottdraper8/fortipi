import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import headless from "@xterm/headless";
import { Ajv } from "ajv";
import { spawn } from "node-pty";
import { hash } from "../tools/unstale/review-supply-chain.ts";
import { filesBelow, packagePaths, repository, run } from "./build-workspaces.ts";
import type { Manifest } from "./check-pins.ts";
import { checkPins, json, rootArgument } from "./check-pins.ts";
import { pnpmExecutable, verifyPnpmExecutable } from "./pnpm-executable.ts";

const exec = promisify(execFile);
const { Terminal } = headless;

/** Terminal input echoes can arrive before the child replies; send the challenge once. */
export function createPtyProbeResponder(send: (input: string) => void): (output: string) => void {
  let sent = false;
  return (output) => {
    if (!sent && output.includes("PTY_READY")) {
      sent = true;
      send("input\r");
    }
  };
}

export async function nativeChecks(): Promise<void> {
  assert.equal(process.versions.node, "26.13.0", "Use the exact reviewed Node runtime");
  console.log("Native probe: pnpm identity");
  const pnpm = await verifyPnpmExecutable(await pnpmExecutable());
  console.log("Native probe: workerd binary");
  const workerRequire = createRequire(resolve(repository, "apps/worker/package.json"));
  const wranglerRequire = createRequire(workerRequire.resolve("wrangler"));
  const workerd = wranglerRequire("workerd") as { default: string; version: string };
  assert.equal(workerd.version, "1.20261110.1");
  const binary = workerd.default;
  const workerVersion = await exec(binary, ["--version"], { timeout: 30_000 });
  assert.match(workerVersion.stdout, /2026-11-10/);
  console.log("Native probe: esbuild transform");
  const esbuild = await import("esbuild");
  assert.equal(esbuild.version, "0.28.2");
  assert.ok(
    esbuild.transformSync("const value: number = 1", { loader: "ts" }).code.includes("value"),
  );
  console.log("Native probe: node-gyp identity");
  const gyp = await exec(process.execPath, ["node_modules/node-gyp/bin/node-gyp.js", "--version"], {
    cwd: repository,
    timeout: 30_000,
  });
  assert.equal(gyp.stdout.trim(), "v13.1.0");
  console.log("Native probe: PTY input/output and rendered cells");
  const terminal = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  await new Promise<void>((accept, reject) => {
    const child = spawn(
      process.execPath,
      [
        "-e",
        "if(!process.stdin.isTTY||!process.stdout.isTTY)process.exit(9); process.stdout.write('PTY_READY\\n'); process.stdin.once('data',()=>{process.stdout.write('PTY_NATIVE_OK\\n');setTimeout(()=>process.exit(0),50)})",
      ],
      { name: "xterm-256color", cols: 80, rows: 24, cwd: repository },
    );
    let output = "";
    const respond = createPtyProbeResponder((input) => child.write(input));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Native PTY timed out"));
    }, 15_000);
    child.onData((data) => {
      output += data;
      terminal.write(data);
      respond(output);
    });
    child.onExit(({ exitCode }) => {
      clearTimeout(timer);
      if (exitCode !== 0 || !output.includes("PTY_NATIVE_OK"))
        reject(new Error(`Native PTY failed: ${exitCode}`));
      else
        terminal.write("", () => {
          const screen = Array.from(
            { length: terminal.rows },
            (_, row) => terminal.buffer.active.getLine(row)?.translateToString(true) ?? "",
          ).join("\n");
          terminal.dispose();
          if (screen.includes("PTY_NATIVE_OK")) accept();
          else reject(new Error("Headless terminal did not render PTY output"));
        });
    });
  });
  console.log(
    `Native binaries: Node/pnpm/esbuild/workerd/node-gyp and actual PTY + screen cells passed on ${process.platform}/${process.arch}`,
  );
  const require = createRequire(import.meta.url);
  const ptyBinary = resolve(
    dirname(require.resolve("node-pty")),
    "../build/Release",
    process.platform === "win32" ? "conpty.node" : "pty.node",
  );
  await mkdir(resolve(repository, "dist/supply-chain"), { recursive: true });
  await writeFile(
    resolve(repository, "dist/supply-chain/native.json"),
    `${JSON.stringify({ platform: process.platform, architecture: process.arch, node: process.versions.node, pnpm, esbuild: esbuild.version, workerd: workerd.version, nodeGyp: gyp.stdout.trim(), nodeSha256: hash(await readFile(process.execPath)), workerdSha256: hash(await readFile(binary)), esbuildSha256: hash(await readFile(resolve(repository, "node_modules/esbuild/bin/esbuild"))), ptySha256: hash(await readFile(ptyBinary)), ptyObservation: "Actual TTY spawn/input/output and headless screen cell assertion passed; source-built from reviewed node-pty1.1.0 archive" }, null, 2)}\n`,
  );
}

export async function egressChecks(): Promise<void> {
  assert.equal(
    (
      await fetch("https://registry.npmjs.org/pnpm/12.18.0", {
        signal: AbortSignal.timeout(15_000),
      })
    ).status,
    200,
  );
  let blocked = false;
  try {
    await fetch("https://example.com", { signal: AbortSignal.timeout(10_000) });
  } catch {
    blocked = true;
  }
  assert.ok(
    blocked,
    "Runner reached deliberately unallowed destination; block enforcement is required",
  );
  console.log(
    `Allowed registry request and rejected example.com probe observed on ${process.platform}/${process.arch}; retain harden-runner log for attribution`,
  );
}

async function metadata(root: string): Promise<void> {
  await checkPins(root);
  for (const path of packagePaths) {
    const manifest = await json<
      Manifest & {
        exports: Record<string, unknown>;
        files: string[];
        bin?: Record<string, string>;
        repository: { directory: string };
        publishConfig: { access: string };
      }
    >(root, `${path}/package.json`);
    assert.equal(manifest.version, "0.1.0");
    assert.equal(manifest.type, "module");
    assert.equal(manifest.license, "SEE LICENSE IN LICENSE");
    assert.equal(manifest.repository.directory, path);
    assert.equal(manifest.publishConfig.access, "public");
    assert.equal(manifest.engines?.node, ">=26.13.0");
    for (const value of Object.values(manifest.exports))
      if (typeof value === "object" && value !== null) {
        const entry = value as { types: string; import: string };
        assert.match(entry.types, /^\.\/dist\/.+\.d\.ts$/);
        assert.match(entry.import, /^\.\/dist\/.+\.js$/);
      }
    for (const item of ["dist", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md", "licenses"])
      assert.ok(manifest.files.includes(item));
    for (const bin of Object.values(manifest.bin ?? {})) assert.equal(bin, "./dist/bin.js");
  }
  const schema = JSON.parse(
    await readFile(resolve(root, "apps/worker/node_modules/wrangler/config-schema.json"), "utf8"),
  ) as object;
  const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
  const validate = ajv.compile(schema);
  const config = await json<Record<string, unknown>>(root, "apps/worker/wrangler.jsonc");
  assert.ok(validate(config), JSON.stringify(validate.errors));
  const overlay = await json<{ durable_objects: { bindings: unknown[] }; migrations: unknown[] }>(
    root,
    "apps/worker/wrangler.container.template.json",
  );
  const core = config as {
    durable_objects: { bindings: unknown[] };
    migrations: unknown[];
    vars: {
      FORTIPI_CONFIG: {
        version: number;
        infrastructure: {
          version: number;
          profile: string;
          accountPlan: string;
          capabilities: unknown[];
          bounds: Record<string, number>;
        };
      };
    };
  };
  const merged = {
    ...config,
    ...overlay,
    durable_objects: {
      bindings: [...core.durable_objects.bindings, ...overlay.durable_objects.bindings],
    },
    migrations: [...core.migrations, ...overlay.migrations],
  };
  assert.ok(validate(merged), JSON.stringify(validate.errors));
  assert.equal(config.worker_loaders, undefined, "Free/unknown config must omit Paid-only Loader");
  assert.equal(config.containers, undefined, "Free/unknown config must omit Paid-only Containers");
  assert.equal(config.r2_buckets, undefined);
  const policy = core.vars.FORTIPI_CONFIG.infrastructure;
  assert.equal(policy.version, 1);
  assert.equal(core.vars.FORTIPI_CONFIG.version, 1);
  assert.equal(policy.profile, "free");
  assert.equal(policy.accountPlan, "unknown");
  assert.deepEqual(policy.capabilities, []);
  const defaults = {
    objectBytes: 134217728,
    installBytes: 536870912,
    headroomFraction: 0.25,
    fileBytes: 4194304,
    snapshotBytes: 16777216,
    stagingBytesPerWorkspace: 16777216,
    manifestEntries: 512,
    retainedVersions: 8,
    workspaceBytes: 67108864,
    inlineTailBytes: 32768,
    artifactBytes: 1048576,
    outputBytesPerJob: 8388608,
    conversationEvents: 2000,
    conversationBytes: 8388608,
    activeMutatingJobs: 1,
    queuedAdmissions: 4,
    requestsPerPrincipalMinute: 30,
    requestsPerInstallMinute: 120,
    sqlPageRows: 100,
    transferConcurrency: 4,
  };
  assert.deepEqual(
    policy.bounds,
    defaults,
    "Infrastructure metadata defaults changed; contract owns runtime schema validation",
  );
  for (const path of await filesBelow(root)) {
    const local = relative(root, path).split(sep).join("/");
    const javascript = /\.[cm]?js$/.test(local);
    const python = local.endsWith(".py");
    if (
      /\.(?:[cm]?js|py|sh|bash|zsh|ps1)$/.test(local) &&
      !(python && local.startsWith("examples/python-client/")) &&
      !(javascript && local.startsWith("packages/fortipi-cli/worker-assets/"))
    )
      throw new Error(`Maintained automation must be TypeScript: ${path}`);
  }
  console.log(
    "Foundation metadata: exports/build intent, real Wrangler schema, Free defaults and optional Linux overlay validated; product exports/runtime unverified",
  );
}

if (import.meta.main) {
  if (process.argv.includes("--egress")) await egressChecks();
  else if (process.argv.includes("--native")) await nativeChecks();
  else {
    const root = rootArgument();
    await metadata(root);
    await run(
      process.execPath,
      ["node_modules/typescript/bin/tsc", "-p", "tsconfig.tools.json"],
      root,
    );
    await run(process.execPath, ["scripts/check-source-integrity.ts"], root);
    await nativeChecks();
  }
}
