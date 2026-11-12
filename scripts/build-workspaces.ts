import { execFile, spawn } from "node:child_process";
import { chmod, copyFile, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { pnpmExecutable, verifyPnpmExecutable } from "./pnpm-executable.ts";

export const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const publicPackages = ["contract", "client", "tui", "executor", "cli"] as const;
export const packagePaths = publicPackages.map((name) => `packages/fortipi-${name}`);
export const projects = [...packagePaths, "apps/worker"];

/** Argument arrays only. A timeout terminates the child and remains a failure. */
export async function run(
  command: string,
  args: string[],
  cwd = repository,
  timeout = 300_000,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const executable =
    command === "pnpm"
      ? await pnpmExecutable(process.platform, (env.PATH ?? env.Path ?? "").split(delimiter))
      : command;
  if (command === "pnpm") await verifyPnpmExecutable(executable, env);
  await new Promise<void>((accept, reject) => {
    const child = spawn(executable, args, { cwd, env, stdio: "inherit", windowsHide: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeout);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0 && !timedOut) accept();
      else
        reject(
          new Error(
            `${command} ${args.join(" ")} failed (${timedOut ? "timeout" : (signal ?? code)})`,
          ),
        );
    });
  });
}

export async function filesBelow(path: string): Promise<string[]> {
  const result: string[] = [];
  for (const item of await readdir(path, { withFileTypes: true })) {
    if (
      ["node_modules", "dist", ".git", ".agent-docs", ".unstale", ".wrangler"].includes(item.name)
    )
      continue;
    const name = join(path, item.name);
    if (item.isDirectory()) result.push(...(await filesBelow(name)));
    else if (item.isFile()) result.push(name);
  }
  return result.sort();
}

async function tests(roots: string[]): Promise<void> {
  const paths: string[] = [];
  for (const root of roots) {
    // Missing required suites fail. Never turn a partial checkout into green CI.
    const found = (await filesBelow(join(repository, root))).filter((p) =>
      /(?:\.test|\.spec)\.ts$/.test(p),
    );
    if (found.length === 0) throw new Error(`Required test suite has no tests: ${root}`);
    paths.push(...found);
  }
  // This fixture mutates the canonical AD context and replaces shared CLI assets.
  // Finish readers from every selected root before running it in its own process.
  const provenance = join(
    repository,
    "packages/fortipi-cli/test/enforcer-context-provenance.test.ts",
  );
  const parallel = paths.filter((path) => path !== provenance);
  if (parallel.length) await run(process.execPath, ["--test", ...parallel], repository, 900_000);
  if (paths.includes(provenance))
    await run(process.execPath, ["--test", provenance], repository, 900_000);
}

async function compile(path: string): Promise<void> {
  await run(process.execPath, ["node_modules/typescript/bin/tsc", "-p", `${path}/tsconfig.json`]);
  const manifest = JSON.parse(await readFile(join(repository, path, "package.json"), "utf8")) as {
    bin?: Record<string, string>;
  };
  for (const bin of Object.values(manifest.bin ?? {})) {
    const target = join(repository, path, bin);
    if (!(await readFile(target, "utf8")).startsWith("#!/usr/bin/env node\n")) {
      throw new Error(`Executable lacks Node shebang: ${target}`);
    }
    await chmod(target, 0o755);
  }
  await copyFile(join(repository, "LICENSE"), join(repository, path, "LICENSE"));
}

export async function main(command: string | undefined): Promise<void> {
  switch (command) {
    case "candidate": {
      const commit = (
        await promisify(execFile)("git", ["rev-parse", "HEAD"], {
          cwd: repository,
          timeout: 15_000,
        })
      ).stdout.trim();
      const manifest = JSON.parse(await readFile(join(repository, "package.json"), "utf8")) as {
        version: string;
      };
      const output = await promisify(execFile)(
        process.execPath,
        [
          "scripts/prepare-release.ts",
          "candidate",
          "--version",
          manifest.version,
          "--commit-sha",
          commit,
          "--scope",
          "fortipi-ci-test",
        ],
        { cwd: repository, timeout: 900_000, maxBuffer: 8_000_000 },
      );
      const receipt = JSON.parse(output.stdout.trim()) as {
        schemaVersion: number;
        candidateManifestPath: string;
        candidateSha256: string;
      };
      if (
        receipt.schemaVersion !== 1 ||
        typeof receipt.candidateManifestPath !== "string" ||
        !/^[a-f0-9]{64}$/.test(receipt.candidateSha256)
      )
        throw new Error("Invalid candidate path/hash receipt");
      const path = await realpath(resolve(repository, receipt.candidateManifestPath));
      const within = relative(repository, path);
      if (isAbsolute(within) || within === ".." || within.startsWith(`..${sep}`))
        throw new Error("Candidate receipt points outside repository");
      const { createHash } = await import("node:crypto");
      if (
        createHash("sha256")
          .update(await readFile(path))
          .digest("hex") !== receipt.candidateSha256
      )
        throw new Error("Candidate receipt hash mismatch");
      await mkdir(join(repository, "dist/supply-chain"), { recursive: true });
      await writeFile(
        join(repository, "dist/supply-chain/candidate-receipt.json"),
        `${JSON.stringify({ ...receipt, candidateManifestPath: path }, null, 2)}\n`,
      );
      if (process.env.GITHUB_ENV)
        await writeFile(process.env.GITHUB_ENV, `FORTIPI_CANDIDATE_MANIFEST=${path}\n`, {
          flag: "a",
        });
      console.log(`Synthetic candidate validated: ${receipt.candidateSha256}`);
      return;
    }
    case "build:executor":
      await run(process.execPath, ["packages/fortipi-contract/scripts/generate.ts"]);
      await compile("packages/fortipi-contract");
      await compile("packages/fortipi-executor");
      return;
    case "build": {
      await run(process.execPath, ["packages/fortipi-contract/scripts/generate.ts"]);
      for (const path of packagePaths.filter((p) => !p.endsWith("-cli"))) await compile(path);
      await mkdir(join(repository, "apps/worker/dist/worker"), { recursive: true });
      await run(
        process.execPath,
        [
          "node_modules/wrangler/bin/wrangler.js",
          "deploy",
          "--dry-run",
          "--outdir",
          "dist/worker",
          "--metafile",
          "dist/worker/metafile.json",
        ],
        join(repository, "apps/worker"),
      );
      const commit = (
        await promisify(execFile)("git", ["rev-parse", "HEAD"], {
          cwd: repository,
          timeout: 15_000,
        })
      ).stdout.trim();
      const rootManifest = JSON.parse(await readFile(join(repository, "package.json"), "utf8")) as {
        version: string;
      };
      await run(process.execPath, [
        "packages/fortipi-cli/scripts/package-worker-assets.ts",
        "--worker-build",
        "apps/worker/dist/worker",
        "--commit-sha",
        commit,
        "--version",
        rootManifest.version,
      ]);
      await compile("packages/fortipi-cli");
      return;
    }
    case "typecheck":
      await run(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.tools.json"]);
      await typecheck(projects);
      return;
    case "typecheck:executor":
      await typecheck(["packages/fortipi-contract", "packages/fortipi-executor"]);
      return;
    case "test":
      await tests([
        ...packagePaths.map((p) => `${p}/test`),
        "apps/worker/test",
        "scripts/test/release",
      ]);
      return;
    case "test:executor":
      await tests(["packages/fortipi-executor/test"]);
      return;
    case "test:browser":
    case "test:pty":
      {
        const extra = process.argv.slice(3).filter((arg) => arg !== "--");
        if (!extra.length) {
          const receipt = JSON.parse(
            await readFile(join(repository, "dist/supply-chain/candidate-receipt.json"), "utf8"),
          ) as { candidateManifestPath: string };
          extra.push(
            "--candidate",
            process.env.FORTIPI_CANDIDATE_MANIFEST ?? receipt.candidateManifestPath,
            "--fixture",
            process.env.FORTIPI_EVIDENCE_FIXTURE ?? "tests/clients/fixtures/local.json",
            "--out",
            "dist/evidence/local",
          );
        }
        await run(
          process.execPath,
          ["tests/clients/run-evidence.ts", "local", ...extra],
          repository,
          900_000,
        );
      }
      return;
    default:
      throw new Error("Expected build, typecheck, test, test:executor, test:browser or test:pty");
  }
}

async function typecheck(paths: readonly string[]): Promise<void> {
  for (const path of paths) {
    const sources = await filesBelow(join(repository, path, "src"));
    if (!sources.some((file) => file.endsWith(".ts")))
      throw new Error(`Required project has no TypeScript sources: ${path}`);
    await run(process.execPath, [
      "node_modules/typescript/bin/tsc",
      "-p",
      `${path}/tsconfig.json`,
      "--noEmit",
    ]);
  }
}

if (import.meta.main) await main(process.argv[2]);
