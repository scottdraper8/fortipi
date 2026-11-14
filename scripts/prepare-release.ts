import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { once } from "node:events";
import { createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, resolve, sep } from "node:path";
import { t as listTar } from "tar";
import { parse as parseYaml } from "yaml";
import type { DeviceEvidenceData } from "../tests/clients/device-observer.ts";
import { validateReleaseReport } from "../tools/compatibility-watch/release.ts";
import {
  attachApplicationRecoveryChannel,
  type InfrastructureObservationPort,
} from "./application-recovery-channel.ts";
import {
  FULL_SOURCE_TEST_TIMEOUT_MS,
  observeSourceTestFailures,
  packagePaths,
  repository,
} from "./build-workspaces.ts";
import {
  resolveCurrentCandidateReference,
  verifyCurrentCandidateRead,
} from "./current-candidate-read.ts";
import {
  generateNotices,
  generateRuntimeNotices,
  type NoticeReceipt,
  type RuntimeNoticeReceipt,
} from "./generate-notices.ts";
import {
  hashFile,
  materializeSourceKitInventory,
  verifySourceKit,
} from "./image-source-distribution.ts";
import { pnpmExecutable, verifyPnpmExecutable } from "./pnpm-executable.ts";
import { rewritePublishNames } from "./rewrite-publish-names.ts";
import { collectRuntimeClosure, createRuntimeBundle } from "./runtime-closure.ts";
import { bundledManifest, copyRuntimeMembers } from "./stage-runtime-bundle.ts";
import {
  type ArtifactReference,
  assertCandidate,
  assertGate,
  assertProducer,
  assertSyntheticLocalGate,
  type CandidateManifest,
  type CandidatePackage,
  canonicalJson,
  cliArgs,
  commitPattern,
  digest,
  type FileRecord,
  freshness,
  type GateReceipt,
  type GitHubRequest,
  git,
  githubRequest,
  integer,
  inventory,
  object,
  type Producer,
  packageEntryPath,
  packageOrder,
  privilegedCheckout,
  REPOSITORY,
  REPOSITORY_ID,
  readJson,
  readProofBundle,
  regularBytes,
  SYNTHETIC_SCOPE,
  safePath,
  saveJson,
  sha256,
  sha512,
  string,
  trustedMain,
  verifyCurrentReadinessSet,
  verifyPayload,
  verifyProducer,
  versionPattern,
} from "./verify-release-gates.ts";

/** Explicit child roles. No application, provider, CF or npm credential is inherited by builds/installers. */
export function childEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {
    CI: "true",
    WRANGLER_SEND_METRICS: "false",
    GOTOOLCHAIN: "local",
  };
  for (const key of [
    "PATH",
    "Path",
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "TEMP",
    "TMP",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "PYTHON",
    "PRE_COMMIT_HOME",
    "CC",
    "CXX",
    "npm_config_node_gyp",
    "npm_config_build_from_source",
    "GITHUB_ACTIONS",
    "GITHUB_REPOSITORY",
    "GITHUB_REPOSITORY_ID",
    "GITHUB_SHA",
    "GITHUB_REF",
    "GITHUB_RUN_ID",
    "GITHUB_RUN_ATTEMPT",
    "GITHUB_WORKFLOW_REF",
    "GITHUB_EVENT_NAME",
    "GITHUB_JOB",
    "GITHUB_SERVER_URL",
    "RUNNER_OS",
    "RUNNER_ARCH",
    "RUNNER_ENVIRONMENT",
  ])
    if (process.env[key]) result[key] = process.env[key];
  return { ...result, ...extra };
}
export interface ProcessResult {
  stdout: string;
  code: number | null;
  timedOut: boolean;
}
export function publicationEnvironment(token: string, emptyAuthPath: string): NodeJS.ProcessEnv {
  return childEnvironment({
    pnpm_config__auth: JSON.stringify({
      "https://registry.npmjs.org": { "@": { authToken: token } },
    }),
    NPM_CONFIG_USERCONFIG: emptyAuthPath,
  });
}
/** Captured output stays private; callers persist only selected, schema-checked facts. */
export async function execute(
  command: string,
  args: string[],
  cwd: string,
  env = childEnvironment(),
  timeout = 300_000,
  progress = false,
  onSpawn?: (child: ChildProcess) => void,
): Promise<ProcessResult> {
  if (onSpawn)
    assert.equal(command, process.execPath, "Private IPC requires the trusted Node executable");
  return new Promise((accept, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      windowsHide: true,
      stdio: onSpawn ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"],
    });
    assert.ok(child.stdout && child.stderr);
    if (
      progress &&
      (command === "pnpm" || basename(command) === "pnpm.exe") &&
      args.length === 2 &&
      args[0] === "run" &&
      args[1] === "test"
    )
      observeSourceTestFailures(child.stdout, (line) => {
        process.stderr.write(line);
      });
    let stdout = "";
    let size = 0;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeout);
    child.stdout.on("data", (data: Buffer) => {
      size += data.length;
      if (size > 16_000_000) {
        timedOut = true;
        child.kill("SIGKILL");
      } else stdout += data.toString("utf8");
      if (progress) process.stderr.write(data);
    });
    child.stderr.on("data", (data: Buffer) => {
      if (progress) process.stderr.write(data);
    });
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("Child executable unavailable"));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      accept({ stdout, code, timedOut });
    });
    try {
      onSpawn?.(child);
    } catch {
      clearTimeout(timer);
      child.kill("SIGKILL");
      reject(new Error("Trusted child channel initialization failed"));
    }
  });
}
async function checked(
  command: string,
  args: string[],
  cwd: string,
  env = childEnvironment(),
  timeout = 300_000,
  progress = false,
  onSpawn?: (child: ChildProcess) => void,
): Promise<string> {
  const result = await execute(command, args, cwd, env, timeout, progress, onSpawn);
  if (result.code !== 0 || result.timedOut)
    console.error(
      JSON.stringify({
        diagnostic: "required-command-failure",
        exitCode: result.code,
        limitHit: result.timedOut,
      }),
    );
  assert.ok(
    result.code === 0 && !result.timedOut,
    `Required command failed: ${basename(command)} ${args[0] ?? ""}`,
  );
  return result.stdout;
}
type ArchivePackage = Pick<CandidatePackage, "name" | "sourceName" | "entries">;
interface ArchivePlan {
  name: string;
  sourceName: string;
  files: ReadonlyMap<string, Readonly<FileRecord>>;
  directories: ReadonlySet<string>;
  total: number;
  compressedLimit: number;
}
const archivePlans = new WeakMap<object, ArchivePlan>();
const producedPackages = new WeakMap<ArchivePackage, object>();
const producedArchives = new Map<string, object>();
const sourcePlans = new Map<string, Promise<CandidatePackage[]>>();
/** Private: reached only after source production or external producer verification. */
function archiveAuthority(expected: ArchivePackage): object {
  const files = new Map<string, Readonly<FileRecord>>();
  const directories = new Set<string>();
  let total = 0;
  for (const entry of expected.entries) {
    const path = packageEntryPath(entry.path);
    assert.ok(!files.has(path), "Duplicate authorized archive file");
    assert.ok(Number.isSafeInteger(entry.size) && entry.size >= 0);
    total += entry.size;
    assert.ok(Number.isSafeInteger(total), "Authorized archive size overflow");
    files.set(path, Object.freeze({ ...entry }));
    const parts = path.split("/");
    while (parts.length > 1) {
      parts.pop();
      directories.add(parts.join("/"));
    }
  }
  const handle = Object.freeze({});
  // Pinned pnpm emits one bounded tar header/path record per expected address.
  // Account for header/alignment data and normal gzip framing without allowing
  // arbitrary extra input merely because a producer authenticated its digest.
  const headerBytes = [...files.keys(), ...directories].reduce(
    (sum, path) => sum + 1024 + Math.ceil((path.length + 1024) / 512) * 512,
    1024,
  );
  const uncompressed = total + headerBytes;
  const compressedLimit = uncompressed + Math.ceil(uncompressed / 100) + 1024 * 1024;
  assert.ok(Number.isSafeInteger(compressedLimit));
  archivePlans.set(handle, {
    name: expected.name,
    sourceName: expected.sourceName,
    files,
    directories,
    total,
    compressedLimit,
  });
  return handle;
}
async function boundedArchive(path: string, authority: object): Promise<void> {
  const plan = archivePlans.get(authority);
  assert.ok(plan, "Unrecognized archive authority");
  const info = await lstat(path);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1);
  assert.ok(info.size <= plan.compressedLimit, "Archive compressed input bound");
}
export async function archiveInventory(
  path: string,
  expected?: ArchivePackage,
  authority?: object,
): Promise<{ entries: FileRecord[]; manifest: Record<string, unknown> }> {
  authority ??= expected ? producedPackages.get(expected) : undefined;
  const plan = authority ? archivePlans.get(authority) : undefined;
  if (authority) assert.ok(plan, "Unrecognized archive authority");
  if (plan) {
    assert.equal(expected?.name, plan.name);
    assert.equal(expected?.sourceName, plan.sourceName);
    await boundedArchive(path, authority as object);
  }
  const byteLimit = plan?.sourceName === "fortipi-cli" ? plan.total : 200_000_000;
  // Expected inventory comes from verified staging or the retained candidate, never tar headers.
  // The source freeze independently pins the only payload eligible for a larger member.
  const seaPath = "worker-assets/linux/container/computerd";
  const sea =
    expected?.sourceName === "fortipi-cli"
      ? expected.entries.find((entry) => entry.path === seaPath)
      : undefined;
  if (sea) {
    assert.match(expected?.name ?? "", /^@[a-z0-9][a-z0-9._-]*\/fortipi-cli$/);
    const frozen = object(
      await readJson(resolve(repository, "apps/worker/container/embedded-freeze.json")),
    );
    assert.equal(sea.sha256, digest(frozen.binarySha256), "Unreviewed archive SEA identity");
    assert.ok(Number.isSafeInteger(sea.size) && sea.size > 0 && sea.size <= 200_000_000);
  }
  const entries: FileRecord[] = [];
  const seen = new Set<string>();
  let manifest: Record<string, unknown> | undefined;
  let total = 0;
  let failure: unknown;
  let headers = 0;
  const parser = listTar({
    strict: true,
    maxMetaEntrySize: 1024 * 1024,
    maxDecompressionRatio: 1000,
    onReadEntry(entry) {
      try {
        assert.ok(++headers < 30000, "Archive header bound");
        assert.ok(
          entry.path.startsWith("package/") && !entry.linkpath,
          "Archive prefix/link rejected",
        );
        if (entry.path === "package/" && entry.type === "Directory") {
          entry.resume();
          return;
        }
        const raw = entry.path.slice(8).replace(/\/$/, "");
        const local =
          plan && entry.type === "Directory" ? raw : (plan ? packageEntryPath : safePath)(raw);
        assert.ok(!seen.has(local.toLowerCase()), "Duplicate normalized archive path");
        seen.add(local.toLowerCase());
        assert.ok(seen.size < 30000, "Archive record bound");
        assert.ok(
          entry.type === "File" || entry.type === "Directory",
          "Special archive entry rejected",
        );
        if (entry.type === "Directory") {
          if (plan) assert.ok(plan.directories.has(local), "Unknown authorized archive directory");
          entry.resume();
          return;
        }
        total += entry.size;
        const authorized = plan?.files.get(local);
        if (plan) {
          assert.ok(authorized, "Unknown authorized archive member");
          assert.equal(entry.size, authorized.size, "Authorized archive size differs");
          assert.equal(
            (entry.mode ?? 0) & 0o777,
            authorized.mode,
            "Authorized archive mode differs",
          );
        }
        const reviewedSea = sea && local === seaPath;
        assert.ok(
          (entry.size <= 32_000_000 || (reviewedSea && entry.size === sea.size)) &&
            total <= byteLimit,
          "Archive byte bound",
        );
        const hash = createHash("sha256");
        let size = 0;
        const chunks: Buffer[] | undefined = local === "package.json" ? [] : undefined;
        entry.on("data", (chunk: Buffer) => {
          size += chunk.length;
          hash.update(chunk);
          chunks?.push(chunk);
        });
        entry.on("end", () => {
          try {
            assert.equal(size, entry.size);
            const sha256 = hash.digest("hex");
            if (authorized)
              assert.equal(sha256, authorized.sha256, "Authorized archive hash differs");
            if (reviewedSea) {
              assert.equal(size, sea.size, "Archive SEA size differs");
              assert.equal(sha256, sea.sha256, "Archive SEA hash differs");
            }
            const mode = (entry.mode ?? 0) & 0o777;
            assert.ok((mode & 0o022) === 0, "Writable archive mode");
            entries.push({ path: local, size, mode, sha256 });
            if (chunks) manifest = object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch (error) {
            failure = error;
            parser.abort(error instanceof Error ? error : new Error("Archive rejected"));
          }
        });
      } catch (error) {
        failure = error;
        parser.abort(error instanceof Error ? error : new Error("Archive rejected"));
      }
    },
  });
  const finished = once(parser, "end");
  const timer = setTimeout(() => parser.abort(new Error("Archive verification timeout")), 120000);
  timer.unref();
  const input = createReadStream(path, { highWaterMark: 64 * 1024 });
  let compressed = 0;
  if (plan)
    input.on("data", (chunk: Buffer) => {
      compressed += chunk.length;
      if (compressed > plan.compressedLimit)
        parser.abort(new Error("Archive compressed input bound"));
    });
  input.on("error", (error) => {
    failure = error;
    parser.abort(error);
  });
  parser.once("error", () => input.destroy());
  try {
    input.pipe(parser);
    await finished;
  } catch (error) {
    throw failure ?? error;
  } finally {
    clearTimeout(timer);
    input.destroy();
  }
  if (failure) throw failure;
  if (plan) {
    assert.equal(total, plan.total, "Authorized archive total differs");
    assert.equal(entries.length, plan.files.size, "Incomplete authorized archive");
  }
  assert.ok(manifest, "Missing package manifest");
  if (expected) assert.equal(manifest.name, expected.name, "Archive package role differs");
  return { entries: entries.sort((a, b) => a.path.localeCompare(b.path, "en")), manifest };
}
export async function stageAndPack(
  root: string,
  output: string,
  scope: string,
  version: string,
): Promise<{
  packages: CandidatePackage[];
  assetManifestSha256: string;
  runtimeNotices: RuntimeNoticeReceipt[];
}> {
  await mkdir(output, { mode: 0o700 });
  const temporary = await mkdtemp(resolve(await realpath(tmpdir()), "fortipi-pack-"));
  try {
    const auth = resolve(temporary, "empty-auth");
    await writeFile(auth, "", { flag: "wx", mode: 0o600 });
    const stage = await rewritePublishNames({
      root,
      destination: resolve(temporary, "stage"),
      scope,
      version,
    });
    const closure = await collectRuntimeClosure(root);
    await mkdir(resolve(temporary, "runtime"));
    await mkdir(resolve(temporary, "legal"));
    const pnpm = await pnpmExecutable();
    await verifyPnpmExecutable(pnpm, childEnvironment());
    const packages: CandidatePackage[] = [];
    const runtimeNotices: RuntimeNoticeReceipt[] = [];
    for (const source of packageOrder) {
      const sourceName = `fortipi-${source}`;
      const directory = resolve(temporary, "stage", sourceName);
      const bundle = await createRuntimeBundle(
        closure,
        sourceName,
        resolve(temporary, "runtime", sourceName),
      );
      const legal = await generateRuntimeNotices(
        root,
        closure,
        bundle.plan,
        resolve(temporary, "legal", sourceName),
      );
      const permitted = new Map(
        legal.conveyance.permittedBlockedFiles.map((file) => [file.path, file]),
      );
      const members = new Map(bundle.plan.files.map((file) => [file.path, file]));
      for (const path of bundle.plan.blockedConveyancePaths)
        assert.deepEqual(
          members.get(path),
          permitted.get(path),
          "Unapproved dependency conveyance path",
        );
      await rm(resolve(directory, "licenses"), { recursive: true });
      await mkdir(resolve(directory, "licenses"));
      for (const file of legal.files) {
        safePath(file.path);
        const target = resolve(directory, file.path);
        if (file.path === "LICENSE" || file.path === "THIRD_PARTY_NOTICES.md") await rm(target);
        await mkdir(dirname(target), { recursive: true });
        await copyFile(resolve(legal.directory, file.path), target, 1);
        await chmod(target, file.mode);
        assert.equal(sha256(await regularBytes(target)), file.sha256);
      }
      const manifest = bundledManifest(
        closure,
        bundle.plan,
        object(await readJson(resolve(directory, "package.json"))),
      );
      // The pinned packer preserves this exact JSON serialization without LF.
      await writeFile(resolve(directory, "package.json"), JSON.stringify(manifest, null, 2));
      const own = await inventory(directory);
      await copyRuntimeMembers(closure, bundle.plan, bundle.directory, directory);
      const expected: FileRecord[] = [...own, ...bundle.plan.files].sort((a, b) =>
        a.path.localeCompare(b.path, "en"),
      );
      const role = { name: `@${scope}/${sourceName}`, sourceName, entries: expected };
      const authority = archiveAuthority(role);
      const result = object(
        JSON.parse(
          await checked(
            pnpm,
            [
              "--ignore-workspace",
              "--ignore-scripts",
              "--npmrc-auth-file",
              auth,
              "pack",
              "--json",
              "--pack-destination",
              output,
            ],
            directory,
            childEnvironment({ NPM_CONFIG_USERCONFIG: auth, NPM_CONFIG_GLOBALCONFIG: auth }),
          ),
        ),
      );
      // Read the tool's actual result, never infer a scoped archive filename.
      const filename = basename(string(result.filename));
      assert.ok(
        result.filename === filename ||
          resolve(string(result.filename)) === resolve(output, filename),
        "Unexpected pack path",
      );
      safePath(filename);
      const file = resolve(output, filename);
      const packed = await archiveInventory(file, role, authority);
      assert.deepEqual(
        packed.manifest,
        await readJson(resolve(directory, "package.json")),
        "Pack changed manifest semantics",
      );
      assert.deepEqual(
        packed.entries.filter((f) => f.path !== "package.json"),
        expected.filter((f) => f.path !== "package.json"),
        "Pack changed/omitted staged payload",
      );
      assert.equal(packed.manifest.name, `@${scope}/fortipi-${source}`);
      assert.equal(packed.manifest.version, version);
      assert.equal(packed.manifest.scripts, undefined);
      assert.equal(object(packed.manifest.publishConfig).directory, undefined);
      for (const key of ["LICENSE", "README.md", "THIRD_PARTY_NOTICES.md"])
        assert.ok(
          packed.entries.some((e) => e.path === key),
          "Missing publication terms",
        );
      const bin = object(packed.manifest.bin ?? {});
      for (const value of Object.values(bin)) {
        const path = string(value).replace(/^\.\//, "");
        const entry = packed.entries.find((e) => e.path === path);
        assert.ok(entry && (entry.mode & 0o111) !== 0, "Nonexecutable public bin");
        assert.ok(
          (await regularBytes(resolve(directory, path)))
            .toString("utf8")
            .startsWith("#!/usr/bin/env node\n"),
          "Missing Node shebang",
        );
      }
      const data = await regularBytes(file);
      const pkg: CandidatePackage = {
        name: String(packed.manifest.name),
        sourceName: `fortipi-${source}`,
        version,
        tarball: `packs/${filename}`,
        sha256: sha256(data),
        integrity: sha512(data),
        entries: packed.entries,
      };
      producedPackages.set(pkg, authority);
      producedArchives.set(pkg.sha256, authority);
      packages.push(pkg);
      const legalDirectory = resolve(output, "legal-evidence", sourceName);
      await mkdir(dirname(legalDirectory), { recursive: true });
      await cp(legal.directory, legalDirectory, {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
      runtimeNotices.push({ ...legal, directory: legalDirectory });
    }
    return { packages, assetManifestSha256: stage.assetManifestSha256, runtimeNotices };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
async function copy(root: string, source: string, destination: string) {
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(resolve(root, source), destination, 1);
}
export async function producer(
  root: string,
  publishable: boolean,
  workflowName: "release.yml" | "deploy.yml" = "release.yml",
  request: GitHubRequest = githubRequest(process.env.GITHUB_TOKEN),
): Promise<Producer> {
  const path = `.github/workflows/${workflowName}`;
  const result: Producer = {
    workflowPath: path,
    workflowSha256: sha256(await regularBytes(resolve(root, path))),
    workflowId: 0,
    runId: Number(process.env.GITHUB_RUN_ID ?? 0),
    runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT ?? 0),
  };
  const currentCandidateJob =
    process.env.GITHUB_ACTIONS === "true" &&
    process.env.GITHUB_JOB === "candidate" &&
    process.env.GITHUB_WORKFLOW_REF ===
      `${REPOSITORY}/.github/workflows/release.yml@refs/heads/main` &&
    process.env.OPERATION === "candidate";
  // A reserved-scope validation artifact still has an actual Actions producer.
  // Recording that lineage never changes its publication eligibility.
  if (publishable || currentCandidateJob) {
    assert.equal(process.env.GITHUB_REPOSITORY, REPOSITORY);
    assert.equal(process.env.GITHUB_REF, "refs/heads/main");
    assert.equal(process.env.GITHUB_EVENT_NAME, "workflow_dispatch");
    result.workflowId = integer(
      object(await request(`/repos/${REPOSITORY}/actions/workflows/${workflowName}`)).id,
    );
    integer(result.runId);
    integer(result.runAttempt);
  }
  return result;
}
/** Current evidence execution, independent of the immutable packing producer. */
export async function evidenceProducer(
  root: string,
  candidate: CandidateManifest,
  mode: "local" | "native" | "live",
  request: GitHubRequest = githubRequest(process.env.GITHUB_TOKEN),
): Promise<Producer> {
  if (process.env.GITHUB_ACTIONS !== "true") {
    assert.equal(mode, "local");
    assert.equal(candidate.publishable, false);
    assert.equal(candidate.scope, SYNTHETIC_SCOPE);
    return {
      workflowPath: ".github/workflows/ci.yml",
      workflowSha256: sha256(await regularBytes(resolve(root, ".github/workflows/ci.yml"))),
      workflowId: 0,
      runId: 0,
      runAttempt: 0,
    };
  }
  assert.equal(process.env.GITHUB_REPOSITORY, REPOSITORY);
  assert.equal(process.env.GITHUB_REPOSITORY_ID, String(REPOSITORY_ID));
  assert.equal(process.env.GITHUB_SHA, candidate.sourceCommit);
  const match = new RegExp(
    `^${REPOSITORY}/(\\.github/workflows/(ci|release|deploy)\\.yml)@refs/`,
  ).exec(string(process.env.GITHUB_WORKFLOW_REF));
  assert.ok(match?.[1] && match[2], "Actual allowlisted evidence workflow required");
  assert.equal(string(process.env.GITHUB_WORKFLOW_REF).split("@")[1], process.env.GITHUB_REF);
  const workflowPath = match[1];
  const workflow = match[2];
  const job = process.env.GITHUB_JOB;
  const event = process.env.GITHUB_EVENT_NAME;
  if (workflow === "ci") {
    assert.equal(job, "policy-and-integration");
    assert.equal(mode, "local");
    assert.ok(["push", "pull_request", "workflow_dispatch"].includes(string(event)));
    if (event !== "workflow_dispatch") {
      assert.equal(candidate.publishable, false);
      assert.equal(candidate.scope, SYNTHETIC_SCOPE);
    }
  } else {
    assert.ok(
      (workflow === "release" && job === "native" && mode === "native") ||
        (workflow === "release" && job === "publish" && mode === "local") ||
        (workflow === "deploy" && job === "operate" && mode === "live"),
      "Evidence workflow/job/mode mismatch",
    );
    assert.equal(event, "workflow_dispatch");
    if (workflow === "release" && job === "native")
      assert.equal(candidate.publishable, candidate.scope !== SYNTHETIC_SCOPE);
    else assert.equal(candidate.publishable, true);
  }
  if (event === "workflow_dispatch") assert.equal(process.env.GITHUB_REF, "refs/heads/main");
  else if (event === "push") assert.equal(process.env.GITHUB_REF, "refs/heads/main");
  else assert.match(string(process.env.GITHUB_REF), /^refs\/pull\/\d+\/merge$/);
  const actual = object(await request(`/repos/${REPOSITORY}/actions/workflows/${workflow}.yml`));
  assert.equal(actual.path, workflowPath);
  assert.equal(actual.state, "active");
  const result: Producer = {
    workflowPath,
    workflowSha256: sha256(await regularBytes(resolve(root, workflowPath))),
    workflowId: integer(actual.id),
    runId: integer(Number(process.env.GITHUB_RUN_ID)),
    runAttempt: integer(Number(process.env.GITHUB_RUN_ATTEMPT)),
  };
  assertProducer(result);
  return result;
}
export function evidenceEnvironment(
  producer: Producer,
  mode: "local" | "native" | "live",
  context?: CandidateReadContext,
) {
  return childEnvironment({
    FORTIPI_EVIDENCE_PRODUCER: canonicalJson(producer),
    ...(mode === "live" ? { FORTIPI_ADMIN_TOKEN: process.env.FORTIPI_ADMIN_TOKEN } : {}),
    ...(mode === "native" && context?.kind === "current"
      ? { RUNNER_NAME: process.env.RUNNER_NAME }
      : {}),
    ...(context
      ? {
          GITHUB_TOKEN: process.env.GITHUB_TOKEN,
          FORTIPI_CANDIDATE_REFERENCE: canonicalJson(context.reference),
          OPERATION: process.env.OPERATION,
          SOURCE_SHA: process.env.SOURCE_SHA,
          RELEASE_VERSION: process.env.RELEASE_VERSION,
          RELEASE_SCOPE: process.env.RELEASE_SCOPE,
          EXPECTED_TAG: process.env.EXPECTED_TAG,
          CONFIRM: process.env.CONFIRM,
        }
      : {}),
  });
}
export function assertEvidenceReceipt(
  value: unknown,
  loaded: { candidate: CandidateManifest; hash: string },
  expected: Producer,
  mode: "local" | "native" | "live",
): asserts value is GateReceipt {
  if (process.env.GITHUB_ACTIONS !== "true")
    assertSyntheticLocalGate(value, loaded.candidate, mode);
  else assertGate(value);
  assert.deepEqual(value.producer, expected, "Evidence producer differs from actual execution");
  assert.equal(value.kind, mode === "local" ? "integrated" : mode);
  assert.equal(value.candidateSha256, loaded.hash);
  assert.equal(value.sourceCommit, loaded.candidate.sourceCommit);
  assert.equal(value.scope, loaded.candidate.scope);
}
/** Authenticate exact retained bytes; no repacking or promotion of a synthetic candidate. */
export async function verifyRetainedCandidate(
  candidate: CandidateManifest,
  hash: string,
  reference: ArtifactReference,
  request: GitHubRequest,
): Promise<void> {
  assert.equal(reference.candidateSha256, hash, "Retained candidate hash mismatch");
  await trustedMain(candidate, request);
  await verifyProducer(candidate, "candidate", candidate.producer, reference, request);
}
export async function generateSbom(
  root: string,
  destination: string,
  scope: string,
  version: string,
  notices: NoticeReceipt[],
): Promise<void> {
  const pnpm = await pnpmExecutable();
  const temporary = resolve(destination, "workspace-sbom-%s.json");
  await checked(
    pnpm,
    [
      "--filter",
      "./packages/*",
      "--filter",
      "./apps/worker",
      "sbom",
      "--prod",
      "--split",
      "--sbom-format",
      "cyclonedx",
      "--sbom-spec-version",
      "1.7",
      "--out",
      temporary,
    ],
    root,
  );
  const reports = (await readdir(destination))
    .filter((file) => file.startsWith("workspace-sbom-") && file.endsWith(".json"))
    .sort();
  assert.equal(reports.length, 6, "All five public and Worker SBOM roots required");
  const graphs = await Promise.all(
    reports.map(async (file) => object(await readJson(resolve(destination, file)))),
  );
  const original = graphs[0];
  assert.ok(original);
  assert.equal(original.bomFormat, "CycloneDX");
  assert.equal(original.specVersion, "1.7");
  const componentMap = new Map<string, Record<string, unknown>>();
  for (const graph of graphs) {
    assert.equal(graph.bomFormat, "CycloneDX");
    assert.equal(graph.specVersion, "1.7");
    const list = [
      object(object(graph.metadata).component),
      ...(Array.isArray(graph.components) ? graph.components.map(object) : []),
    ];
    for (const c of list) componentMap.set(string(c["bom-ref"]), c);
  }
  const components = [...componentMap.values()];
  const runtimeNotices = notices.filter((notice): notice is RuntimeNoticeReceipt =>
    Object.hasOwn(notice, "conveyance"),
  );
  const dispositions = new Map<string, { bundled: unknown[]; external: unknown[] }>();
  const disposition = (id: string) => {
    let value = dispositions.get(id);
    if (!value) {
      value = { bundled: [], external: [] };
      dispositions.set(id, value);
    }
    return value;
  };
  for (const notice of runtimeNotices) {
    for (const component of notice.conveyance.components)
      disposition(component.archiveId).bundled.push({
        owner: notice.package,
        addresses: component.addresses,
        files: component.files.length,
        fileSetSha256: sha256(canonicalJson(component.files)),
        planSha256: notice.conveyance.planSha256,
      });
    for (const component of notice.conveyance.external)
      disposition(component.archiveId).external.push({ owner: notice.package, ...component });
  }
  if (runtimeNotices.length) {
    await mkdir(resolve(destination, "supply-chain"), { recursive: true });
    await saveJson(resolve(destination, "supply-chain/runtime-conveyance.json"), {
      schemaVersion: 1,
      packages: runtimeNotices.map((notice) => ({
        package: notice.package,
        conveyance: notice.conveyance,
        files: notice.files,
        texts: notice.texts,
      })),
    });
  }
  const runtime = new Set(notices.flatMap((n) => n.components));
  // The actual Worker closure's original license files enumerate its bundled runtime components.
  const { verifyAssets } = await import("../packages/fortipi-cli/dist/assets.js");
  const assets = await verifyAssets(resolve(root, "packages/fortipi-cli/worker-assets"));
  const review = object(
    object(await readJson(resolve(root, "tools/unstale/supply-chain.json"))).packages,
  );
  const workerNotices = (
    await regularBytes(
      resolve(root, "packages/fortipi-cli/worker-assets/licenses/THIRD_PARTY_NOTICES.md"),
    )
  ).toString("utf8");
  for (const match of workerNotices.matchAll(
    /^- (.+@[^:]+): .+; original archive SHA256 ([a-f0-9]{64})$/gm,
  )) {
    const id = string(match[1]);
    assert.equal(object(review[id]).archiveSha256, match[2]);
    runtime.add(id);
  }
  const sourceInventory = object(
    await readJson(
      resolve(
        root,
        "apps/worker/dist/container/context/notices/debian-sources/source-license-inventory.json",
      ),
    ),
  );
  const embedded = object(
    await readJson(
      resolve(root, "apps/worker/dist/container/context/notices/embedded/embedded-inventory.json"),
    ),
  );
  assert.ok(Array.isArray(embedded.components));
  const refs = new Map<string, string>();
  const fullName = (c: Record<string, unknown>) =>
    c.group ? `${c.group}/${c.name}` : String(c.name);
  const mapped = components
    .filter(
      (c) => runtime.has(`${fullName(c)}@${c.version}`) || String(c.name).startsWith("fortipi-"),
    )
    .map((c) => {
      if (typeof c.name === "string" && packageOrder.some((p) => c.name === `fortipi-${p}`)) {
        const ref = `pkg:npm/%40${scope}/${c.name}@${version}`;
        refs.set(string(c["bom-ref"]), ref);
        return {
          ...c,
          "bom-ref": ref,
          purl: ref,
          name: `@${scope}/${c.name}`,
          version,
          licenses: [{ license: { id: "LicenseRef-Sustainable-Use-1.0" } }],
        };
      }
      return c;
    });
  for (const id of runtime)
    if (!mapped.some((c) => `${fullName(c)}@${c.version}` === id)) {
      const fact = object(review[id]);
      mapped.push({
        type: "library",
        name: string(fact.name),
        version: string(fact.version),
        "bom-ref": `pkg:npm/${encodeURIComponent(string(fact.name)).replaceAll("%2F", "/")}@${fact.version}`,
        hashes: [{ alg: "SHA-256", content: string(fact.archiveSha256) }],
        licenses: [{ expression: string(fact.license) }],
        properties: [
          {
            name: "fortipi:distribution",
            value: "external-runtime-dependency-metadata; native/tool conveyance not asserted",
          },
        ],
      });
    }
  for (const component of mapped) {
    const member = dispositions.get(`${fullName(component)}@${component.version}`);
    if (!member) continue;
    const existing = Array.isArray(component.properties)
      ? component.properties
          .map(object)
          .filter((property) => property.name !== "fortipi:distribution")
      : [];
    component.properties = [
      ...existing,
      {
        name: "fortipi:distribution",
        value: member.bundled.length
          ? "bundled-runtime-files"
          : "external-runtime-dependency-metadata",
      },
      { name: "fortipi:runtime-disposition", value: canonicalJson(member) },
      { name: "fortipi:conveyance-evidence", value: "supply-chain/runtime-conveyance.json" },
    ];
  }
  const bundled = assets.manifest.files
    .filter((f) => f.kind === "worker")
    .map((f) => ({
      type: "file",
      name: `embedded-worker/${f.path}`,
      hashes: [{ alg: "SHA-256", content: f.sha256 }],
      properties: [{ name: "fortipi:distribution", value: "bundled" }],
    }));
  const debian = Object.keys(sourceInventory)
    .sort()
    .map((id) => {
      const split = id.lastIndexOf("=");
      assert.ok(split > 0);
      return {
        type: "library",
        name: id.slice(0, split),
        version: id.slice(split + 1),
        properties: [{ name: "fortipi:distribution", value: "linux-image-source-package" }],
      };
    });
  const image = object(
    await readJson(resolve(root, "apps/worker/dist/container/image-metadata.json")),
  );
  const native = embedded.components.map((row) => {
    const c = object(row);
    return {
      name: string(c.name),
      version: string(c.version),
      hashes: [{ alg: "SHA-256", content: string(c.sha256) }],
      type: "library",
      properties: [{ name: "fortipi:distribution", value: "embedded-native-image" }],
    };
  });
  await saveJson(resolve(destination, "sbom.json"), {
    ...original,
    components: [
      ...mapped,
      ...bundled,
      ...debian,
      ...native,
      {
        type: "application",
        name: "Node.js",
        version: string(image.embeddedNodeVersion),
        properties: [{ name: "fortipi:distribution", value: "embedded-image" }],
      },
    ],
    metadata: {
      ...object(original.metadata),
      component: {
        type: "application",
        name: "FortiPi release",
        version,
        licenses: [{ license: { name: "Sustainable Use License 1.0" } }],
      },
    },
    dependencies: graphs
      .flatMap((g) => (Array.isArray(g.dependencies) ? g.dependencies.map(object) : []))
      .filter((d) => mapped.some((c) => c["bom-ref"] === (refs.get(String(d.ref)) ?? d.ref)))
      .map((d) => ({
        ...d,
        ref: refs.get(String(d.ref)) ?? d.ref,
        dependsOn: Array.isArray(d.dependsOn)
          ? d.dependsOn
              .map((ref) => refs.get(String(ref)) ?? ref)
              .filter((ref) => mapped.some((c) => c["bom-ref"] === ref))
          : [],
      })),
    properties: [{ name: "fortipi:sourceKitSha256", value: string(image.sourceKitSha256) }],
  });
  for (const file of reports) await rm(resolve(destination, file));
}
export interface CandidateOptions {
  version: string;
  commitSha: string;
  scope: string;
}
export class CompatibilityPreparationFailure extends Error {
  readonly failureClass: "spawn" | "report-parse" | "report-write" | "required-assessment";
  constructor(failureClass: "spawn" | "report-parse" | "report-write" | "required-assessment") {
    super(`Compatibility preparation refused: ${failureClass}`);
    this.name = "CompatibilityPreparationFailure";
    this.failureClass = failureClass;
  }
}
/** Closed failure categories; never expose child output, errors or request material. */
export async function retainCompatibilityReport(
  root: string,
  path: string,
  run: () => Promise<ProcessResult>,
): Promise<void> {
  let result: ProcessResult;
  try {
    result = await run();
  } catch {
    throw new CompatibilityPreparationFailure("spawn");
  }
  let report: unknown;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    throw new CompatibilityPreparationFailure("report-parse");
  }
  try {
    assert.equal(result.code, 0);
    assert.equal(result.timedOut, false);
    await validateReleaseReport(root, report, await git("rev-parse", "HEAD"));
  } catch {
    throw new CompatibilityPreparationFailure("required-assessment");
  }
  try {
    await saveJson(path, report);
  } catch {
    throw new CompatibilityPreparationFailure("report-write");
  }
}
/** Build before stage/pack, without recursively invoking owner10's installed/browser/PTY evidence. */
export async function prepareCandidate(
  options: CandidateOptions,
): Promise<{ schemaVersion: 1; candidateManifestPath: string; candidateSha256: string }> {
  assert.match(options.version, versionPattern);
  assert.match(options.commitSha, commitPattern);
  assert.match(options.scope, /^[a-z0-9][a-z0-9._-]*$/);
  assert.equal(await git("rev-parse", "HEAD"), options.commitSha);
  assert.equal(
    await git("status", "--porcelain"),
    "",
    "Candidate source must be committed and clean",
  );
  const root = repository;
  const publishable = options.scope !== SYNTHETIC_SCOPE;
  const p = await producer(root, publishable);
  const before = await git("ls-files", "-s");
  const lock = sha256(await regularBytes(resolve(root, "pnpm-lock.yaml")));
  const manifest = object(await readJson(resolve(root, "package.json")));
  assert.equal(manifest.version, options.version);
  for (const path of [...packagePaths, "apps/worker"])
    assert.equal(
      object(await readJson(resolve(root, path, "package.json"))).version,
      options.version,
    );
  if (publishable) {
    assert.equal(
      await git("merge-base", options.commitSha, "refs/remotes/origin/main"),
      options.commitSha,
    );
    assert.equal(await git("rev-parse", "refs/remotes/origin/main"), options.commitSha);
  }
  const destination = resolve(
    root,
    ".agent-docs/tmp/release",
    options.version,
    options.commitSha,
    options.scope,
  );
  await mkdir(dirname(destination), { recursive: true });
  await mkdir(destination, { mode: 0o700 });
  let phase = "foundation inventory";
  try {
    const pnpm = await pnpmExecutable();
    // Foundation inventory precedes the asset producer. Its normal checker reauthenticates all cached SRI archives.
    await checked(
      process.execPath,
      ["scripts/check-licenses.ts", "--foundation"],
      root,
      childEnvironment(),
      300000,
      true,
    );
    phase = "Worker build";
    await checked(pnpm, ["run", "build"], root, childEnvironment(), 600000, true);
    assert.equal(
      object(
        await readJson(resolve(root, "packages/fortipi-cli/worker-assets/asset-manifest.json")),
      ).sourceCommit,
      options.commitSha,
      "Embedded assets must be built at this candidate source",
    );
    phase = "compatibility review";
    await retainCompatibilityReport(root, resolve(destination, "compatibility.json"), () =>
      execute(
        process.execPath,
        [
          "tools/compatibility-watch/watch.ts",
          "--release",
          ...(process.env.GITHUB_ACTIONS === "true" ? [] : ["--gh"]),
        ],
        root,
        childEnvironment({ GITHUB_TOKEN: process.env.GITHUB_TOKEN }),
        180000,
      ),
    );
    phase = "notices";
    await generateNotices(root);
    for (const args of [
      ["run", "typecheck"],
      ["run", "lint"],
      ["run", "schema:check"],
      ["run", "check:pins"],
      ["run", "check:licenses"],
      ["run", "unstale:check"],
      ["run", "test"],
    ]) {
      phase = `source check ${args[1]}`;
      await checked(
        pnpm,
        args,
        root,
        childEnvironment(),
        args[1] === "test" ? FULL_SOURCE_TEST_TIMEOUT_MS : 900000,
        true,
      );
    }
    phase = "pre-commit checks";
    await checked("pre-commit", ["run", "--all-files"], root, childEnvironment(), 600000, true);
    phase = "package archives";
    const packed = await stageAndPack(
      root,
      resolve(destination, "packs"),
      options.scope,
      options.version,
    );
    phase = "SBOM";
    await generateSbom(root, destination, options.scope, options.version, packed.runtimeNotices);
    phase = "specification and source payload";
    for (const file of [
      "openapi.yaml",
      ...(await inventory(resolve(root, "packages/fortipi-contract/schemas"))).map(
        (f) => `schemas/${f.path}`,
      ),
    ])
      await copy(root, `packages/fortipi-contract/${file}`, resolve(destination, "spec", file));
    for (const notice of packed.runtimeNotices)
      for (const file of notice.files) {
        const source = resolve(notice.directory, safePath(file.path));
        assert.equal(sha256(await regularBytes(source, file.size)), file.sha256);
        await copy(root, source, resolve(destination, "legal", notice.package, file.path));
      }
    for (const file of ["image-metadata.json", "source-revision.json", "sources-and-notices.tar"])
      await copy(root, `apps/worker/dist/container/${file}`, resolve(destination, "image", file));
    for (const file of ["inventory.json", "advisory-review.json"])
      await copy(root, `dist/supply-chain/${file}`, resolve(destination, "supply-chain", file));
    const image = object(await readJson(resolve(destination, "image/image-metadata.json")));
    await materializeSourceKitInventory(
      {
        kit: resolve(destination, "image/sources-and-notices.tar"),
        kitSha256: string(image.sourceKitSha256),
      },
      resolve(destination, "image/source-kit-inventory.json"),
    );
    phase = "candidate manifest";
    const candidate: CandidateManifest = {
      schemaVersion: 1,
      repository: REPOSITORY,
      repositoryId: REPOSITORY_ID,
      branch: "main",
      sourceCommit: options.commitSha,
      version: options.version,
      tag: `v${options.version}`,
      scope: options.scope,
      publishable,
      createdAt: new Date().toISOString(),
      producer: p,
      hashes: {
        publishNames: sha256(canonicalJson(object(manifest.fortipi).publishNames)),
        lock,
        toolchainPolicy: sha256(
          await regularBytes(resolve(root, "tools/unstale/supply-chain.json")),
        ),
      },
      assetManifestSha256: packed.assetManifestSha256,
      image: {
        sourceCommit: string(image.sourceCommit),
        metadataSha256: sha256(
          await regularBytes(resolve(destination, "image/image-metadata.json")),
        ),
        imageId: string(image.imageId),
        builtManifestDigest: string(image.builtManifestDigest),
        sourceKitSha256: string(image.sourceKitSha256),
      },
      packages: packed.packages,
      files: await inventory(destination),
    };
    assertCandidate(candidate);
    assert.equal(
      sha256(await regularBytes(resolve(destination, "image/sources-and-notices.tar"))),
      candidate.image.sourceKitSha256,
    );
    if (publishable) await trustedMain(candidate, githubRequest(process.env.GITHUB_TOKEN));
    assert.equal(await git("ls-files", "-s"), before);
    assert.equal(await git("status", "--porcelain"), "");
    assert.equal(sha256(await regularBytes(resolve(root, "pnpm-lock.yaml"))), lock);
    const candidateManifestPath = resolve(destination, "candidate.json");
    const candidateSha256 = await saveJson(candidateManifestPath, candidate);
    return { schemaVersion: 1, candidateManifestPath, candidateSha256 };
  } catch (error) {
    if (error instanceof CompatibilityPreparationFailure)
      console.error(
        JSON.stringify({
          diagnostic: "compatibility-release-failure",
          failureClass: error.failureClass,
        }),
      );
    console.error(`Candidate preparation failed during ${phase}.`);
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}
/** Derive expected bodies from the current clean checkout, independently of candidate entries. */
async function sourceCandidatePlans(
  candidate: CandidateManifest,
): Promise<CandidatePackage[] | undefined> {
  if (candidate.sourceCommit !== (await git("rev-parse", "HEAD"))) return undefined;
  assert.equal(
    await git("status", "--porcelain"),
    "",
    "Source archive authority requires a clean checkout",
  );
  const assetPath = resolve(repository, "packages/fortipi-cli/worker-assets/asset-manifest.json");
  const assets = await regularBytes(assetPath, 8_000_000);
  assert.equal(sha256(assets), candidate.assetManifestSha256);
  assert.equal(object(JSON.parse(assets.toString("utf8"))).sourceCommit, candidate.sourceCommit);
  assert.equal(
    sha256(await regularBytes(resolve(repository, "pnpm-lock.yaml"))),
    candidate.hashes.lock,
  );
  assert.equal(
    sha256(await regularBytes(resolve(repository, "tools/unstale/supply-chain.json"))),
    candidate.hashes.toolchainPolicy,
  );
  assert.equal(
    sha256(
      canonicalJson(
        object(object(await readJson(resolve(repository, "package.json"))).fortipi).publishNames,
      ),
    ),
    candidate.hashes.publishNames,
  );
  const key = `${candidate.sourceCommit}:${candidate.scope}:${candidate.version}:${candidate.assetManifestSha256}`;
  let pending = sourcePlans.get(key);
  if (!pending) {
    pending = (async () => {
      const temporary = await mkdtemp(resolve(await realpath(tmpdir()), "fortipi-source-plan-"));
      try {
        return (
          await stageAndPack(
            repository,
            resolve(temporary, "packs"),
            candidate.scope,
            candidate.version,
          )
        ).packages;
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    })();
    sourcePlans.set(key, pending);
  }
  return pending;
}
export type CandidateReadContext =
  | { kind: "current" | "retained"; reference: ArtifactReference; request: GitHubRequest }
  | { kind?: undefined; reference: ArtifactReference; request: GitHubRequest };

/** Metadata is data only; this function grants no package archive authority. */
async function candidateMetadata(
  path: string,
): Promise<{ candidate: CandidateManifest; hash: string; directory: string }> {
  const data = await regularBytes(path, 8_000_000);
  const candidate: unknown = JSON.parse(data.toString("utf8"));
  assertCandidate(candidate);
  assert.equal(
    data.toString("utf8"),
    `${canonicalJson(candidate)}\n`,
    "Noncanonical candidate bytes",
  );
  const hash = sha256(data);
  return { candidate, hash, directory: dirname(resolve(path)) };
}

/** Only trusted setup callers construct a live API request; serialized references are data. */
export async function resolveCandidateReadContext(
  path: string,
): Promise<CandidateReadContext | undefined> {
  if (
    process.env.GITHUB_ACTIONS === "true" &&
    (process.env.GITHUB_JOB === "native" || process.env.GITHUB_JOB === "native-receipt")
  ) {
    const { candidate, hash } = await candidateMetadata(path);
    const request = githubRequest(process.env.GITHUB_TOKEN);
    return {
      kind: "current",
      reference: await resolveCurrentCandidateReference(candidate, hash, request),
      request,
    };
  }
  if (process.env.FORTIPI_CANDIDATE_REFERENCE) {
    assert.equal(process.env.GITHUB_ACTIONS, "true");
    return {
      kind: "retained",
      reference: object(
        JSON.parse(string(process.env.FORTIPI_CANDIDATE_REFERENCE, 60000)),
      ) as unknown as ArtifactReference,
      request: githubRequest(process.env.GITHUB_TOKEN),
    };
  }
  return undefined;
}

/** Workflow operation callers require an explicit authenticated artifact context.
 * Local source qualification continues to use the independent clean-source plan. */
export async function loadWorkflowCandidate(path: string) {
  const context = await resolveCandidateReadContext(path);
  if (process.env.GITHUB_ACTIONS === "true")
    assert.ok(context, "Workflow candidate artifact reference required before payload access");
  return loadCandidate(path, context);
}

async function authenticateCandidateRead(
  loaded: { candidate: CandidateManifest; hash: string },
  context?: CandidateReadContext,
): Promise<void> {
  if (context?.kind === "current")
    await verifyCurrentCandidateRead(
      loaded.candidate,
      loaded.hash,
      context.reference,
      context.request,
    );
  else if (context)
    await verifyRetainedCandidate(
      loaded.candidate,
      loaded.hash,
      context.reference,
      context.request,
    );
}

export async function loadCandidate(
  path: string,
  context?: CandidateReadContext,
): Promise<{ candidate: CandidateManifest; hash: string; directory: string }> {
  const loaded = await candidateMetadata(path);
  const { candidate, hash, directory } = loaded;
  // Authenticate metadata through the actual producer archive before touching payloads.
  // A candidate's inventory is data, never its own source of producer authority.
  await authenticateCandidateRead(loaded, context);
  const needsSource =
    !context &&
    candidate.packages.some(
      (pkg) =>
        !producedArchives.has(pkg.sha256) &&
        (pkg.entries.some((file) => file.path.startsWith("node_modules/")) ||
          pkg.entries.reduce((sum, file) => sum + file.size, 0) > 200_000_000),
    );
  const source = needsSource ? await sourceCandidatePlans(candidate) : undefined;
  const authorities = new Map<string, object>();
  for (const pkg of candidate.packages) {
    const independentlyProduced = source?.find((entry) => entry.name === pkg.name);
    if (independentlyProduced)
      assert.deepEqual(
        pkg.entries,
        independentlyProduced.entries,
        "Retained files differ from trusted source production",
      );
    const authority = context
      ? archiveAuthority(pkg)
      : independentlyProduced
        ? producedPackages.get(independentlyProduced)
        : producedArchives.get(pkg.sha256);
    if (!authority) continue;
    const plan = archivePlans.get(authority);
    assert.ok(plan);
    assert.equal(plan.name, pkg.name);
    assert.equal(plan.sourceName, pkg.sourceName);
    assert.deepEqual(
      pkg.entries,
      [...plan.files.values()].sort((a, b) => a.path.localeCompare(b.path, "en")),
      "Candidate differs from independently produced files",
    );
    authorities.set(pkg.name, authority);
    producedPackages.set(pkg, authority);
    // Check compressed input size before verifyPayload hashes/allocates it.
    await boundedArchive(resolve(directory, pkg.tarball), authority);
  }
  await verifyPayload(directory, candidate.files, ["candidate.json"]);
  for (const p of candidate.packages) {
    const authority = authorities.get(p.name);
    const bytes = await regularBytes(
      resolve(directory, p.tarball),
      authority ? archivePlans.get(authority)?.compressedLimit : undefined,
    );
    assert.equal(sha256(bytes), p.sha256);
    assert.equal(sha512(bytes), p.integrity);
    const packed = await archiveInventory(
      resolve(directory, p.tarball),
      p,
      authorities.get(p.name),
    );
    assert.deepEqual(packed.entries, p.entries);
    assert.equal(packed.manifest.name, p.name);
    assert.equal(packed.manifest.version, p.version);
    assert.equal(packed.manifest.scripts, undefined);
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies"])
      for (const [name, spec] of Object.entries(object(packed.manifest[field] ?? {}))) {
        assert.ok(!name.startsWith("fortipi-"));
        assert.match(string(spec), versionPattern);
        if (candidate.packages.some((pkg) => pkg.name === name))
          assert.equal(spec, candidate.version);
      }
    if (p.sourceName === "fortipi-cli")
      assert.equal(
        p.entries.find((f) => f.path === "worker-assets/asset-manifest.json")?.sha256,
        candidate.assetManifestSha256,
      );
  }
  return { candidate, hash, directory };
}
export type PublicationState =
  | "never-attempted"
  | "upload-intent"
  | "accepted"
  | "accepted-but-unavailable"
  | "unknown"
  | "available";
export interface PublicationJournal {
  schemaVersion: 1;
  candidateSha256: string;
  sourceCommit: string;
  scope: string;
  packages: {
    name: string;
    version: string;
    sha256: string;
    state: PublicationState;
    updatedAt: string;
    attemptedBy: { runId: number; runAttempt: number } | null;
  }[];
}
export async function registryArchive(
  pkg: CandidatePackage,
  transport: typeof fetch = fetch,
): Promise<"absent" | "matching"> {
  const response = await transport(
    `https://registry.npmjs.org/${encodeURIComponent(pkg.name)}/${pkg.version}`,
    { redirect: "error", signal: AbortSignal.timeout(20000) },
  );
  if (response.status === 404) {
    await response.body?.cancel();
    return "absent";
  }
  assert.ok(response.ok, `Registry metadata HTTP ${response.status}`);
  const metadata = object(await response.json());
  assert.equal(metadata.name, pkg.name);
  assert.equal(metadata.version, pkg.version);
  const dist = object(metadata.dist);
  assert.equal(dist.integrity, pkg.integrity, "Registry integrity collision");
  const url = new URL(string(dist.tarball));
  assert.equal(url.origin, "https://registry.npmjs.org");
  assert.ok(!url.username && !url.password && !url.search);
  const archive = await transport(url, { redirect: "error", signal: AbortSignal.timeout(30000) });
  assert.ok(archive.ok, `Registry archive HTTP ${archive.status}`);
  const data = new Uint8Array(await archive.arrayBuffer());
  assert.equal(sha256(data), pkg.sha256, "Registry archive collision");
  assert.equal(sha512(data), pkg.integrity);
  return "matching";
}
/** Durable intent before effects. A retained unknown/accepted intent can only reconcile, never upload again. */
export async function publishPackages(
  candidate: CandidateManifest,
  candidateHash: string,
  directory: string,
  journalPath: string,
  perform: (pkg: CandidatePackage) => Promise<ProcessResult>,
  transport: typeof fetch = fetch,
): Promise<PublicationJournal> {
  assertCandidate(candidate);
  assert.ok(candidate.publishable && candidate.scope !== SYNTHETIC_SCOPE);
  digest(candidateHash);
  await mkdir(dirname(journalPath), { recursive: true, mode: 0o700 });
  const lease = await open(`${journalPath}.lock`, "wx", 0o600);
  try {
    let journal: PublicationJournal;
    try {
      journal = (await readJson(journalPath)) as PublicationJournal;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      assert.ok(
        Number(process.env.GITHUB_RUN_ATTEMPT ?? 1) === 1,
        "A rerun requires its retained publication journal",
      );
      journal = {
        schemaVersion: 1,
        candidateSha256: candidateHash,
        sourceCommit: candidate.sourceCommit,
        scope: candidate.scope,
        packages: candidate.packages.map((p) => ({
          name: p.name,
          version: p.version,
          sha256: p.sha256,
          state: "never-attempted",
          updatedAt: new Date().toISOString(),
          attemptedBy: null,
        })),
      };
      await saveJson(journalPath, journal);
    }
    assert.equal(journal.schemaVersion, 1);
    assert.equal(journal.candidateSha256, candidateHash);
    assert.equal(journal.sourceCommit, candidate.sourceCommit);
    assert.equal(journal.scope, candidate.scope);
    assert.equal(journal.packages.length, 5);
    assert.equal(
      new Set(journal.packages.map((row) => row.name)).size,
      5,
      "Duplicate journal package",
    );
    for (const pkg of candidate.packages) {
      const row = journal.packages.find((row) => row.name === pkg.name);
      assert.ok(row);
      assert.equal(row.version, pkg.version);
      assert.equal(row.sha256, pkg.sha256);
      assert.ok(
        [
          "never-attempted",
          "upload-intent",
          "accepted",
          "accepted-but-unavailable",
          "unknown",
          "available",
        ].includes(row.state),
      );
    }
    const update = async (row: PublicationJournal["packages"][number], state: PublicationState) => {
      row.state = state;
      row.updatedAt = new Date().toISOString();
      await saveJson(journalPath, journal, false);
    };
    for (const source of packageOrder) {
      const pkg = candidate.packages.find((p) => p.sourceName === `fortipi-${source}`);
      assert.ok(pkg);
      const row = journal.packages.find((p) => p.name === pkg.name);
      assert.ok(row);
      assert.equal(row.version, pkg.version);
      assert.equal(row.sha256, pkg.sha256);
      assert.ok(
        [
          "never-attempted",
          "upload-intent",
          "accepted",
          "accepted-but-unavailable",
          "unknown",
          "available",
        ].includes(row.state),
      );
      assert.equal(sha256(await regularBytes(resolve(directory, pkg.tarball))), pkg.sha256);
      if ((await registryArchive(pkg, transport)) === "matching") {
        await update(row, "available");
        continue;
      }
      assert.equal(
        row.state,
        "never-attempted",
        "Uncertain prior upload remains blocked until registry reconciliation; do not retry",
      );
      row.attemptedBy = {
        runId: Number(process.env.GITHUB_RUN_ID ?? 0),
        runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT ?? 0),
      };
      await update(row, "upload-intent");
      let result: ProcessResult;
      try {
        result = await perform(pkg);
      } catch {
        await update(row, "unknown");
        throw new Error(
          "Publication transport uncertain; retained intent prohibits another upload",
        );
      }
      let accepted = result.code === 0 && !result.timedOut;
      if (!accepted) {
        try {
          const error = object(JSON.parse(result.stdout));
          accepted = object(error.error ?? error).code === "ERR_PNPM_PUBLISH_AVAILABILITY_TIMEOUT";
        } catch {
          /* Unknown process outcome stays unknown. */
        }
      }
      await update(
        row,
        accepted ? (result.code === 0 ? "accepted" : "accepted-but-unavailable") : "unknown",
      );
      if ((await registryArchive(pkg, transport)) === "matching") await update(row, "available");
      else
        throw new Error(
          accepted
            ? "Upload accepted but unavailable; reconcile without another upload"
            : "Upload outcome unknown; reconcile without another upload",
        );
    }
    return journal;
  } finally {
    await lease.close();
    await rm(`${journalPath}.lock`);
  }
}
export interface VerifiedPublication {
  name: string;
  version: string;
  sha256: string;
  runId: number;
  runAttempt: number;
  statementSha256: string;
  certificateSha256: string;
}
export function verifyProvenance(
  value: unknown,
  candidate: CandidateManifest,
): VerifiedPublication[] {
  const result = object(value);
  assert.ok(Array.isArray(result.verified), "npm returned no verified attestations");
  const verified: VerifiedPublication[] = [];
  for (const pkg of candidate.packages) {
    const matches: Record<string, unknown>[] = result.verified
      .map(object)
      .filter((r: Record<string, unknown>) => r.name === pkg.name && r.version === pkg.version);
    assert.ok(matches.length > 0, `Missing verified provenance: ${pkg.name}`);
    assert.ok(
      matches.some(
        (r) =>
          Array.isArray(r.attestationBundles) &&
          r.attestationBundles.some((raw: unknown) => {
            const record = object(raw);
            if (
              !["https://slsa.dev/provenance/v1", "https://slsa.dev/provenance/v0.2"].includes(
                String(record.predicateType),
              )
            )
              return false;
            const bundle = object(record.bundle);
            const envelope = object(bundle.dsseEnvelope);
            const statement = object(
              JSON.parse(Buffer.from(string(envelope.payload, 200000), "base64").toString("utf8")),
            );
            assert.ok(Array.isArray(statement.subject));
            assert.ok(
              statement.subject.some((s) => {
                const hash = object(object(s).digest);
                return (
                  hash.sha256 === pkg.sha256 ||
                  hash.sha512 === Buffer.from(pkg.integrity.slice(7), "base64").toString("hex")
                );
              }),
              "Provenance subject differs from retained archive",
            );
            const predicate = object(statement.predicate);
            const build = object(predicate.buildDefinition ?? {});
            const external = object(build.externalParameters ?? {});
            const workflow = object(external.workflow ?? {});
            const details = object(predicate.runDetails ?? {});
            const metadata = object(details.metadata ?? {});
            const invocation = string(metadata.invocationId);
            const lineage = invocation.match(
              /^https:\/\/github\.com\/scottdraper8\/fortipi\/actions\/runs\/([1-9]\d*)\/attempts\/([1-9]\d*)$/,
            );
            assert.ok(lineage, "Missing exact publishing run attempt");
            const runId = integer(Number(lineage[1]));
            const runAttempt = integer(Number(lineage[2]));
            assert.equal(workflow.repository, `https://github.com/${REPOSITORY}`);
            assert.equal(workflow.ref, `refs/heads/main`);
            assert.equal(workflow.path, ".github/workflows/release.yml");
            assert.ok(
              Array.isArray(build.resolvedDependencies) &&
                build.resolvedDependencies.some(
                  (d) => object(object(d).digest).gitCommit === candidate.sourceCommit,
                ),
              "Provenance source SHA mismatch",
            );
            // npm/pacote already cryptographically verified these exact bundles and their certificate identity.
            const material = object(bundle.verificationMaterial);
            const chain = material.x509CertificateChain
              ? object(material.x509CertificateChain).certificates
              : undefined;
            const certificate = object(
              material.certificate ?? (Array.isArray(chain) ? chain[0] : undefined),
            );
            const parsed = new X509Certificate(
              Buffer.from(string(certificate.rawBytes, 32768), "base64"),
            );
            assert.ok(
              parsed.subjectAltName
                ?.split(", ")
                .includes(
                  `URI:https://github.com/${REPOSITORY}/.github/workflows/release.yml@refs/heads/main`,
                ),
              "Unexpected provenance certificate workflow identity",
            );
            verified.push({
              name: pkg.name,
              version: pkg.version,
              sha256: pkg.sha256,
              runId,
              runAttempt,
              statementSha256: sha256(Buffer.from(string(envelope.payload, 200000), "base64")),
              certificateSha256: sha256(parsed.raw),
            });
            return true;
          }),
      ),
      `Missing source-bound verified provenance: ${pkg.name}`,
    );
  }
  return verified;
}
async function verifyPublishingLineage(
  candidate: CandidateManifest,
  record: VerifiedPublication,
  request: GitHubRequest,
): Promise<void> {
  const base = `/repos/${REPOSITORY}/actions/runs/${record.runId}`;
  const current = object(await request(base));
  const attempt = object(await request(`${base}/attempts/${record.runAttempt}`));
  assert.ok(Number(current.run_attempt) >= record.runAttempt);
  for (const r of [current, attempt]) {
    assert.equal(r.id, record.runId);
    assert.equal(r.head_sha, candidate.sourceCommit);
    assert.equal(r.head_branch, "main");
    assert.equal(r.event, "workflow_dispatch");
    assert.equal(r.workflow_id, candidate.producer.workflowId);
    assert.equal(string(r.path).split("@")[0], ".github/workflows/release.yml");
    assert.equal(object(r.repository).id, REPOSITORY_ID);
    assert.equal(object(r.head_repository).id, REPOSITORY_ID);
  }
  assert.equal(attempt.run_attempt, record.runAttempt);
  const isCurrent =
    record.runId === Number(process.env.GITHUB_RUN_ID) &&
    record.runAttempt === Number(process.env.GITHUB_RUN_ATTEMPT);
  assert.ok(
    isCurrent || attempt.status === "completed",
    "Prior publishing attempt must be quiescent",
  );
  let found = false;
  for (let page = 1; page <= 20; page++) {
    const data = object(
      await request(`${base}/attempts/${record.runAttempt}/jobs?per_page=100&page=${page}`),
    );
    assert.ok(Array.isArray(data.jobs));
    const jobs = data.jobs.map(object);
    const job = jobs.find((j) => j.name === "publish");
    if (job) {
      assert.ok(job.started_at && job.conclusion !== "skipped");
      found = true;
    }
    if (page * 100 >= Number(data.total_count)) break;
    assert.ok(page < 20);
  }
  assert.ok(found, "Publishing job lineage unavailable");
}
/** Historical publisher attempts are not behavioral proof. A lost intent never authorizes another upload. */
export async function publicationHistory(
  candidate: CandidateManifest,
  request: GitHubRequest,
): Promise<{ runId: number; runAttempt: number } | null> {
  let latest: { runId: number; runAttempt: number } | null = null;
  for (let page = 1; page <= 20; page++) {
    const data = object(
      await request(
        `/repos/${REPOSITORY}/actions/workflows/release.yml/runs?branch=main&event=workflow_dispatch&head_sha=${candidate.sourceCommit}&per_page=100&page=${page}`,
      ),
    );
    assert.ok(Array.isArray(data.workflow_runs));
    for (const value of data.workflow_runs) {
      const run = object(value);
      assert.equal(run.head_sha, candidate.sourceCommit);
      assert.equal(object(run.repository).id, REPOSITORY_ID);
      assert.equal(object(run.head_repository).id, REPOSITORY_ID);
      const id = integer(run.id);
      const last = integer(run.run_attempt);
      for (let attempt = 1; attempt <= last; attempt++) {
        assert.ok(last <= 100, "Unbounded publication attempt history");
        let started = false;
        for (let jobsPage = 1; jobsPage <= 20; jobsPage++) {
          const jobs = object(
            await request(
              `/repos/${REPOSITORY}/actions/runs/${id}/attempts/${attempt}/jobs?per_page=100&page=${jobsPage}`,
            ),
          );
          assert.ok(Array.isArray(jobs.jobs));
          started ||= jobs.jobs
            .map(object)
            .some(
              (job) =>
                job.name === "publish" &&
                typeof job.started_at === "string" &&
                job.conclusion !== "skipped",
            );
          if (jobsPage * 100 >= Number(jobs.total_count)) break;
          assert.ok(jobsPage < 20);
        }
        if (
          started &&
          !(
            id === Number(process.env.GITHUB_RUN_ID) &&
            attempt === Number(process.env.GITHUB_RUN_ATTEMPT)
          ) &&
          (!latest || id > latest.runId || (id === latest.runId && attempt > latest.runAttempt))
        )
          latest = { runId: id, runAttempt: attempt };
      }
    }
    if (page * 100 >= Number(data.total_count)) break;
    assert.ok(page < 20, "Publication history truncated");
  }
  return latest;
}
async function restorePublicationJournal(
  candidate: CandidateManifest,
  hash: string,
  descriptorPath: string,
  destination: string,
  latest: { runId: number; runAttempt: number } | null,
  request: GitHubRequest,
): Promise<void> {
  const ref = object(await readJson(descriptorPath));
  const runId = integer(ref.runId);
  const runAttempt = integer(ref.runAttempt);
  assert.deepEqual(
    { runId, runAttempt },
    latest,
    "Journal must come from the latest started publisher",
  );
  assert.equal(ref.candidateSha256, hash);
  const record: VerifiedPublication = {
    name: "",
    version: candidate.version,
    sha256: hash,
    runId,
    runAttempt,
    statementSha256: hash,
    certificateSha256: hash,
  };
  await verifyPublishingLineage(candidate, record, request);
  const saved = object(
    await request(`/repos/${REPOSITORY}/actions/artifacts/${integer(ref.artifactId)}`),
  );
  const name = `publication-${candidate.sourceCommit}-${candidate.scope}-${runId}-${runAttempt}`;
  assert.equal(saved.name, name);
  assert.equal(saved.digest, ref.artifactDigest);
  assert.equal(saved.expired, false);
  const origin = object(saved.workflow_run);
  assert.equal(origin.id, runId);
  assert.equal(origin.head_sha, candidate.sourceCommit);
  assert.equal(origin.repository_id, REPOSITORY_ID);
  assert.equal(origin.head_repository_id, REPOSITORY_ID);
  const attempt = object(
    await request(`/repos/${REPOSITORY}/actions/runs/${runId}/attempts/${runAttempt}`),
  );
  assert.ok(
    Date.parse(string(saved.created_at)) >= Date.parse(string(attempt.run_started_at)) &&
      Date.parse(string(saved.created_at)) <= Date.parse(string(attempt.updated_at)),
  );
  assert.ok(Date.parse(string(saved.expires_at)) > Date.now());
  const bytes = await request.verifyArtifact(
    {
      runId,
      runAttempt,
      artifactId: integer(ref.artifactId),
      artifactName: name,
      artifactDigest: string(ref.artifactDigest),
      candidateSha256: hash,
    },
    "journal.json",
  );
  assert.ok(bytes);
  const journal = object(JSON.parse(bytes.toString("utf8")));
  assert.equal(journal.candidateSha256, hash);
  assert.equal(journal.sourceCommit, candidate.sourceCommit);
  assert.equal(journal.scope, candidate.scope);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
}
async function npmIdentity(
  candidate: CandidateManifest,
  token: string,
  transport: typeof fetch = fetch,
): Promise<void> {
  assert.equal(
    process.env.NPM_SCOPE,
    candidate.scope,
    "Final scope must match protected NPM_SCOPE",
  );
  const response = await transport("https://registry.npmjs.org/-/whoami", {
    headers: { Authorization: `Bearer ${token}` },
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  assert.ok(response.ok, "npm identity unavailable");
  const username = string(object(await response.json()).username);
  for (const pkg of candidate.packages) {
    const existing = await transport(`https://registry.npmjs.org/${encodeURIComponent(pkg.name)}`, {
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    if (existing.status === 404) {
      await existing.body?.cancel();
      continue;
    }
    assert.ok(existing.ok, "Existing package identity unavailable");
    const metadata = object(await existing.json());
    assert.equal(metadata.name, pkg.name);
    if (username === candidate.scope) continue;
    const rights = await transport(
      `https://registry.npmjs.org/-/package/${encodeURIComponent(pkg.name)}/collaborators`,
      {
        headers: { Authorization: `Bearer ${token}` },
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      },
    );
    assert.ok(rights.ok, "Existing package collaborator authority unproved");
    assert.ok(
      ["read-write", "write"].includes(String(object(await rights.json())[username])),
      "Unrelated npm package identity",
    );
  }
}
export async function publishCandidate(
  path: string,
  proofsPath: string,
  journalPath: string,
  confirmation: string,
  readinessDirectory: string,
  priorJournal?: string,
): Promise<void> {
  const { candidate, hash, directory } = await loadWorkflowCandidate(path);
  assert.equal(
    confirmation,
    `publish ${candidate.tag} ${candidate.sourceCommit} ${candidate.scope}`,
  );
  await privilegedCheckout(candidate);
  const history = await publicationHistory(candidate, githubRequest(process.env.GITHUB_TOKEN));
  if (priorJournal && Object.keys(object(await readJson(priorJournal))).length === 0)
    priorJournal = undefined;
  if (priorJournal)
    await restorePublicationJournal(
      candidate,
      hash,
      priorJournal,
      journalPath,
      history,
      githubRequest(process.env.GITHUB_TOKEN),
    );
  await checked(
    process.execPath,
    [
      "scripts/verify-release-gates.ts",
      "verify",
      "--candidate",
      path,
      "--proofs",
      proofsPath,
      "--readiness",
      readinessDirectory,
      "--phase",
      "readiness",
    ],
    repository,
    childEnvironment({ GITHUB_TOKEN: process.env.GITHUB_TOKEN }),
    120000,
  );
  const token = process.env.NPM_TOKEN;
  const { proofs } = await readProofBundle(proofsPath);
  assert.ok(token, "npm publication credential absent");
  await npmIdentity(candidate, token);
  const scratch = await mkdtemp(resolve(await realpath(tmpdir()), "fortipi-publish-"));
  try {
    const auth = resolve(scratch, "empty-auth");
    await writeFile(auth, "", { flag: "wx", mode: 0o600 });
    const pnpm = await pnpmExecutable();
    const authEnv = publicationEnvironment(token, auth);
    for (const key of [
      "GITHUB_ACTIONS",
      "GITHUB_REPOSITORY",
      "GITHUB_REPOSITORY_ID",
      "GITHUB_REPOSITORY_OWNER_ID",
      "GITHUB_EVENT_NAME",
      "GITHUB_REF",
      "GITHUB_SHA",
      "GITHUB_WORKFLOW_REF",
      "GITHUB_RUN_ID",
      "GITHUB_RUN_ATTEMPT",
      "GITHUB_SERVER_URL",
      "GITHUB_WORKFLOW_SHA",
      "RUNNER_ENVIRONMENT",
      "ACTIONS_ID_TOKEN_REQUEST_URL",
      "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
    ])
      if (process.env[key]) authEnv[key] = process.env[key];
    await publishPackages(candidate, hash, directory, journalPath, async (pkg) => {
      assert.ok(
        !history || priorJournal,
        "An earlier publisher started: lost journal permits registry reconciliation only, never another upload",
      );
      await verifyCurrentReadinessSet(
        candidate,
        hash,
        proofs,
        { directory: readinessDirectory, phase: "readiness" },
        githubRequest(process.env.GITHUB_TOKEN),
      );
      return execute(
        pnpm,
        [
          "--ignore-workspace",
          "--npmrc-auth-file",
          auth,
          "publish",
          resolve(directory, pkg.tarball),
          "--ignore-scripts",
          "--access",
          "public",
          "--provenance",
          "--publish-wait-timeout",
          "600000",
          "--no-git-checks",
          "--json",
        ],
        scratch,
        authEnv,
        660000,
      );
    });
    const consumer = resolve(scratch, "registry-consumer");
    await mkdir(consumer);
    const verificationDependencies = object(
      object(await readJson(resolve(repository, "package.json"))).devDependencies,
    );
    await writeFile(
      resolve(consumer, "package.json"),
      canonicalJson({
        private: true,
        type: "module",
        dependencies: Object.fromEntries(candidate.packages.map((p) => [p.name, p.version])),
        devDependencies: Object.fromEntries(
          ["typescript", "@types/node"].map((name) => [name, verificationDependencies[name]]),
        ),
      }),
    );
    assert.equal(
      (await checked("npm", ["--version"], consumer)).trim(),
      "11.20.0",
      "Use pinned Node-bundled npm",
    );
    const env = childEnvironment({ NPM_CONFIG_USERCONFIG: auth });
    await checked(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--registry=https://registry.npmjs.org",
        "--cache",
        resolve(scratch, "cache"),
      ],
      consumer,
      env,
    );
    await verifyRegistryConsumer(consumer, candidate, directory);
    const audit = object(
      JSON.parse(
        await checked(
          "npm",
          ["audit", "signatures", "--json", "--include-attestations"],
          consumer,
          env,
        ),
      ),
    );
    const verified = verifyProvenance(audit, candidate);
    for (const record of verified)
      await verifyPublishingLineage(candidate, record, githubRequest(process.env.GITHUB_TOKEN));
    assert.ok(Array.isArray(audit.verified));
    const bundlesSha256 = await saveJson(resolve(dirname(journalPath), "verified-bundles.json"), {
      schemaVersion: 1,
      candidateSha256: hash,
      packages: audit.verified
        .map(object)
        .filter((row) =>
          candidate.packages.some((p) => p.name === row.name && p.version === row.version),
        )
        .map((row) => ({
          name: row.name,
          version: row.version,
          attestationBundles: row.attestationBundles,
        })),
    });
    await saveJson(resolve(dirname(journalPath), "provenance.json"), {
      schemaVersion: 1,
      candidateSha256: hash,
      sourceCommit: candidate.sourceCommit,
      checkedAt: new Date().toISOString(),
      verifiedPackages: verified,
      bundlesSha256,
      publicationRunId: Number(process.env.GITHUB_RUN_ID),
      publicationRunAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
    });
    // Registry distribution must be reobserved by the successor runner, never inferred from upload.
    await runEvidence(
      "local",
      path,
      string(process.env.FORTIPI_EVIDENCE_FIXTURE),
      resolve(scratch, "registry-evidence"),
    );
    await cp(
      resolve(scratch, "registry-evidence"),
      resolve(dirname(journalPath), "registry-evidence"),
      { recursive: true, force: false, errorOnExist: true },
    );
    await saveJson(resolve(dirname(journalPath), "registry-evidence-inventory.json"), {
      schemaVersion: 1,
      candidateSha256: hash,
      files: await inventory(resolve(dirname(journalPath), "registry-evidence")),
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
export interface EvidenceRecovery {
  checkpointDirectory: string;
  coordinator: Parameters<typeof attachApplicationRecoveryChannel>[2];
  forbiddenValues?: readonly string[];
  infrastructure?: InfrastructureObservationPort;
}
export async function runEvidence(
  mode: "local" | "native" | "live",
  candidate: string,
  fixture: string,
  out: string,
  deployment?: string,
  recovery?: EvidenceRecovery,
  devices?: DeviceEvidenceData,
): Promise<void> {
  assert.ok(mode === "live" || devices === undefined, "Device history is live-only");
  if (recovery) {
    assert.equal(mode, "live");
    assert.equal(recovery.checkpointDirectory, resolve(out, "application-recovery"));
  }
  const context = await resolveCandidateReadContext(candidate);
  const loaded = await loadCandidate(candidate, context);
  const expectedProducer = await evidenceProducer(repository, loaded.candidate, mode);
  await regularBytes(resolve(repository, "tests/clients/run-evidence.ts"));
  assert.ok(
    resolve(fixture).startsWith(`${resolve(repository, "tests/clients/fixtures")}${sep}`) &&
      fixture.endsWith(".json"),
    "Evidence fixture must be a trusted source descriptor",
  );
  await regularBytes(resolve(fixture));
  const env = evidenceEnvironment(expectedProducer, mode, context);
  const devicesPath = devices ? resolve(dirname(out), `${basename(out)}.devices.json`) : undefined;
  if (devicesPath) await saveJson(devicesPath, devices);
  let channel: ReturnType<typeof attachApplicationRecoveryChannel> | undefined;
  let childError: unknown;
  try {
    await checked(
      process.execPath,
      [
        "tests/clients/run-evidence.ts",
        mode,
        "--candidate",
        resolve(candidate),
        ...(deployment ? ["--deployment", resolve(deployment)] : []),
        ...(devicesPath ? ["--devices", devicesPath] : []),
        "--fixture",
        resolve(fixture),
        "--out",
        resolve(out),
      ],
      repository,
      env,
      900000,
      true,
      recovery
        ? (child) => {
            channel = attachApplicationRecoveryChannel(
              child,
              recovery.checkpointDirectory,
              recovery.coordinator,
              recovery.forbiddenValues,
              recovery.infrastructure,
            );
          }
        : undefined,
    );
  } catch (error) {
    childError = error;
  }
  try {
    await channel?.settled();
    if (childError) throw childError;
  } finally {
    channel?.close();
  }
  const receipt = await readJson(resolve(out, "gate.json"));
  assertEvidenceReceipt(receipt, loaded, expectedProducer, mode);
  await verifyPayload(out, receipt.files, ["gate.json"]);
}
/** Registry-resolved verification runs before any release finalization; exact bytes and the reviewed graph both matter. */
async function verifyRegistryConsumer(
  consumer: string,
  candidate: CandidateManifest,
  directory: string,
): Promise<void> {
  const review = object(await readJson(resolve(directory, "supply-chain/inventory.json")));
  assert.ok(Array.isArray(review.packages));
  const facts = new Map(
    review.packages.map((raw) => {
      const item = object(raw);
      return [string(item.id), item.integrity];
    }),
  );
  const lock = object(await readJson(resolve(consumer, "package-lock.json")));
  for (const [path, raw] of Object.entries(object(lock.packages))) {
    if (path === "") continue;
    const value = object(raw);
    const name = path.split("node_modules/").at(-1);
    assert.ok(name);
    const id = `${name}@${string(value.version)}`;
    const owned = candidate.packages.find((pkg) => `${pkg.name}@${pkg.version}` === id);
    assert.equal(
      value.integrity,
      owned?.integrity ?? facts.get(id),
      `Unreviewed registry dependency/SRI: ${id}`,
    );
    assert.ok(owned || facts.has(id), `Unreviewed registry dependency: ${id}`);
  }
  for (const pkg of candidate.packages)
    for (const file of pkg.entries) {
      const path = resolve(consumer, "node_modules", pkg.name, file.path);
      assert.equal(
        sha256(await regularBytes(path)),
        file.sha256,
        "Registry-installed owned bytes differ",
      );
    }
  await checked(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `for(const name of ${JSON.stringify(candidate.packages.map((pkg) => pkg.name))})await import(name);`,
    ],
    consumer,
    childEnvironment(),
  );
  const prefix = `@${candidate.scope}/fortipi-`;
  await writeFile(
    resolve(consumer, "consumer.ts"),
    `import type {Protocol} from "${prefix}contract";import {FortiPiClient} from "${prefix}client";import {FortiPiClient as NodeClient} from "${prefix}client/node";import {Controller} from "${prefix}tui";import {ExecutorRuntime} from "${prefix}executor";import {runCommand} from "${prefix}cli";export type Public=Protocol;void [FortiPiClient,NodeClient,Controller,ExecutorRuntime,runCommand];\n`,
    { flag: "wx" },
  );
  await checked(
    process.execPath,
    [
      resolve(consumer, "node_modules/typescript/bin/tsc"),
      "--ignoreConfig",
      "--strict",
      "--skipLibCheck",
      "false",
      "--types",
      "node",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--target",
      "ES2024",
      "--lib",
      "ES2024,DOM,DOM.Iterable",
      "--noEmit",
      "consumer.ts",
    ],
    consumer,
    childEnvironment(),
  );
  for (const name of ["cli", "tui"])
    await checked(
      process.execPath,
      [resolve(consumer, "node_modules", `${prefix}${name}`, "dist/bin.js"), "--help"],
      consumer,
      childEnvironment(),
    );
}
/** Only retained scoped packages are served here. External dependencies use the normal public registry. */
export async function installCandidate(
  path: string,
  destination: string,
  selection: string[] = packageOrder.map((p) => `fortipi-${p}`),
  verificationTools = false,
  context?: CandidateReadContext,
): Promise<{ consumer: string; cliBin: string; candidateSha256: string }> {
  const { candidate, hash, directory } = await loadCandidate(path, context);
  await mkdir(destination, { mode: 0o700 });
  assert.ok(
    !destination.startsWith(`${repository}${sep}`),
    "Installed consumer must be outside checkout",
  );
  assert.ok(
    selection.length > 0 &&
      selection.every((name) => candidate.packages.some((p) => p.sourceName === name)),
  );
  let origin = "";
  let count = 0;
  let failed = false;
  const server = createServer((request, response) => {
    void (async () => {
      assert.equal(request.method, "GET");
      assert.ok(++count <= 2048);
      const route = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      if (route.startsWith("/archive/")) {
        const name = decodeURIComponent(route.slice(9));
        const pkg = candidate.packages.find((p) => basename(p.tarball) === name);
        assert.ok(pkg);
        const data = await regularBytes(resolve(directory, pkg.tarball));
        assert.equal(sha256(data), pkg.sha256);
        response.writeHead(200, { "content-type": "application/octet-stream" });
        response.end(data);
        return;
      }
      const name = decodeURIComponent(route.slice(1));
      const pkg = candidate.packages.find((p) => p.name === name);
      assert.ok(pkg, "Out-of-scope candidate registry request");
      const { manifest } = await archiveInventory(resolve(directory, pkg.tarball), pkg);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          name,
          versions: {
            [pkg.version]: {
              ...manifest,
              dist: {
                integrity: pkg.integrity,
                tarball: `${origin}/archive/${encodeURIComponent(basename(pkg.tarball))}`,
              },
            },
          },
          "dist-tags": { latest: pkg.version },
        }),
      );
    })().catch(() => {
      failed = true;
      response.writeHead(503);
      response.end("Retained candidate unavailable");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  origin = `http://127.0.0.1:${address.port}`;
  try {
    const auth = resolve(destination, "empty-auth");
    await writeFile(auth, "", { flag: "wx", mode: 0o600 });
    const consumer = resolve(destination, "consumer");
    await mkdir(consumer);
    const tooling = verificationTools
      ? object(object(await readJson(resolve(repository, "package.json"))).devDependencies)
      : {};
    await writeFile(
      resolve(consumer, "package.json"),
      canonicalJson({
        private: true,
        type: "module",
        dependencies: Object.fromEntries(
          candidate.packages
            .filter((p) => selection.includes(p.sourceName))
            .map((p) => [p.name, p.version]),
        ),
        ...(verificationTools
          ? {
              devDependencies: {
                typescript: string(tooling.typescript),
                "@types/node": string(tooling["@types/node"]),
              },
            }
          : {}),
      }),
    );
    const pnpm = await pnpmExecutable();
    await checked(
      pnpm,
      [
        "--ignore-workspace",
        "--npmrc-auth-file",
        auth,
        "install",
        "--ignore-scripts",
        "--no-frozen-lockfile",
        "--registry=https://registry.npmjs.org",
        `--config.@${candidate.scope}:registry=${origin}`,
        "--config.node-linker=hoisted",
        "--config.package-import-method=copy",
        `--config.store-dir=${resolve(destination, "store")}`,
        "--config.auto-install-peers=false",
      ],
      consumer,
      childEnvironment(),
      600000,
    );
    assert.equal(failed, false, "Candidate registry boundary rejected install request");
    const review = object(await readJson(resolve(directory, "supply-chain/inventory.json")));
    assert.ok(Array.isArray(review.packages));
    const facts = new Map(
      review.packages.map((row) => {
        const fact = object(row);
        return [string(fact.id), fact];
      }),
    );
    const lock = object(
      parseYaml((await regularBytes(resolve(consumer, "pnpm-lock.yaml"))).toString("utf8")),
    );
    for (const [id, raw] of Object.entries(object(lock.packages))) {
      const resolution = object(object(raw).resolution);
      const owned = candidate.packages.find((p) => id === `${p.name}@${p.version}`);
      if (owned)
        assert.equal(
          resolution.integrity,
          owned.integrity,
          "Installed scoped resolution differs from retained bytes",
        );
      else {
        const fact = facts.get(id);
        assert.ok(fact, `Unreviewed installed runtime dependency: ${id}`);
        assert.equal(
          resolution.integrity,
          fact.integrity,
          `Installed dependency SRI differs from reviewed archive: ${id}`,
        );
      }
    }
    for (const pkg of candidate.packages) {
      const installed = resolve(consumer, "node_modules", pkg.name);
      try {
        await lstat(installed);
      } catch {
        assert.ok(!selection.includes(pkg.sourceName));
        continue;
      }
      assert.ok(
        (await realpath(installed)).startsWith(`${consumer}${sep}node_modules${sep}`),
        "Workspace package resolution forbidden",
      );
      for (const file of pkg.entries) {
        const stat = await lstat(resolve(installed, file.path));
        assert.ok(!stat.isSymbolicLink() && stat.isFile());
        assert.equal(stat.size, file.size);
        assert.equal(
          sha256(await regularBytes(resolve(installed, file.path))),
          file.sha256,
          "Installed candidate bytes differ",
        );
      }
    }
    const modules = resolve(consumer, "node_modules");
    const protect = async (path: string): Promise<void> => {
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) {
        assert.ok(
          (await realpath(path)).startsWith(`${modules}${sep}`),
          "Installed dependency link escapes consumer",
        );
        return;
      }
      if (stat.isDirectory()) {
        for (const name of await readdir(path)) await protect(resolve(path, name));
        await chmod(path, 0o555);
      } else await chmod(path, stat.mode & 0o111 ? 0o555 : 0o444);
    };
    await protect(resolve(consumer, "node_modules"));
    return {
      consumer,
      cliBin: resolve(consumer, "node_modules", `@${candidate.scope}/fortipi-cli/dist/bin.js`),
      candidateSha256: hash,
    };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((accept, reject) =>
      server.close((error) => (error ? reject(error) : accept())),
    );
  }
}
/** Import authenticated image inputs without rebuilding or relabeling their runtime. */
export async function prepareImage(descriptorPath: string, downloaded: string): Promise<void> {
  const d = object(await readJson(descriptorPath));
  const source = string(d.sourceCommit);
  assert.match(source, commitPattern);
  const metadataHash = digest(d.metadataSha256);
  const request = githubRequest(process.env.GITHUB_TOKEN);
  const base = `/repos/${REPOSITORY}`;
  const runId = integer(d.runId);
  const attempt = integer(d.runAttempt);
  const artifactId = integer(d.artifactId);
  const run = object(await request(`${base}/actions/runs/${runId}`));
  const exact = object(await request(`${base}/actions/runs/${runId}/attempts/${attempt}`));
  for (const r of [run, exact]) {
    assert.equal(r.id, runId);
    assert.equal(r.head_sha, source);
    assert.equal(r.run_attempt, attempt);
    assert.equal(r.status, "completed");
    assert.equal(r.conclusion, "success");
    assert.equal(object(r.repository).id, REPOSITORY_ID);
    assert.equal(object(r.head_repository).id, REPOSITORY_ID);
    assert.equal(string(r.path).split("@")[0], ".github/workflows/image-proof.yml");
    assert.ok(
      ["push", "workflow_dispatch"].includes(string(r.event)),
      "Image proof must be trusted, not PR output",
    );
    assert.ok(
      r.head_branch === "main" ||
        /^ci\/fortipi-image-proof-[a-z0-9-]+$/.test(string(r.head_branch)),
      "Untrusted image source branch",
    );
  }
  const imageJobs: Record<string, unknown>[] = [];
  for (let page = 1; page <= 20; page++) {
    const data = object(
      await request(
        `${base}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100&page=${page}`,
      ),
    );
    assert.ok(Array.isArray(data.jobs));
    imageJobs.push(...data.jobs.map(object));
    if (page * 100 >= Number(data.total_count)) break;
    assert.ok(page < 20);
  }
  for (const name of ["Image proof (rootful)", "Image proof (rootless)"]) {
    const matches = imageJobs.filter((job) => job.name === name);
    assert.equal(matches.length, 1);
    assert.equal(matches[0]?.status, "completed");
    assert.equal(matches[0]?.conclusion, "success");
  }
  const artifact = object(await request(`${base}/actions/artifacts/${artifactId}`));
  assert.equal(
    artifact.name,
    `container-distribution-rootless-${source}-${runId}-${attempt}`,
    "Full qualified image input artifact required",
  );
  assert.equal(artifact.expired, false);
  assert.equal(artifact.digest, d.artifactDigest);
  assert.equal(object(artifact.workflow_run).id, runId);
  assert.equal(object(artifact.workflow_run).head_sha, source);
  assert.equal(object(artifact.workflow_run).repository_id, REPOSITORY_ID);
  assert.equal(object(artifact.workflow_run).head_repository_id, REPOSITORY_ID);
  assert.ok(Date.parse(string(artifact.expires_at)) > Date.now());
  assert.ok(
    Date.parse(string(artifact.created_at)) >= Date.parse(string(exact.run_started_at)) &&
      Date.parse(string(artifact.created_at)) <= Date.parse(string(exact.updated_at)),
  );
  const originalMetadata = await request.verifyArtifact(
    {
      runId,
      runAttempt: attempt,
      artifactId,
      artifactName: string(artifact.name),
      artifactDigest: string(artifact.digest),
      candidateSha256: metadataHash,
    },
    "image-metadata.json",
  );
  assert.ok(originalMetadata);
  assert.equal(
    sha256(originalMetadata),
    metadataHash,
    "Image metadata differs from actual producer archive",
  );
  const metadata = await regularBytes(resolve(downloaded, "image-metadata.json"), 8_000_000);
  assert.equal(sha256(metadata), metadataHash);
  const image = object(JSON.parse(metadata.toString("utf8")));
  assert.equal(image.sourceCommit, source);
  assert.equal(image.builtManifestSource, "docker-save-oci");
  assert.equal(image.registryDigest, null);
  assert.equal(
    await git("merge-base", source, "HEAD"),
    source,
    "Image source must be an accepted ancestor",
  );
  await git("diff", "--exit-code", source, "HEAD", "--", "apps/worker/container");
  await importQualifiedImageInputs(
    downloaded,
    source,
    metadata,
    resolve(repository, "apps/worker/dist/container"),
  );
}

/** Metadata must first be authenticated to its completed image producer by the
 * caller. This port verifies local input bytes; it creates no runtime proof. */
export async function importQualifiedImageInputs(
  downloaded: string,
  source: string,
  metadata: Buffer,
  output: string,
): Promise<void> {
  assert.match(source, commitPattern);
  assert.ok(metadata.length <= 8_000_000, "Image metadata byte bound");
  const image = object(JSON.parse(metadata.toString("utf8")));
  assert.equal(image.sourceCommit, source);
  await git("diff", "--exit-code", source, "HEAD", "--", "apps/worker/container");
  const temporary = await mkdtemp(resolve(await realpath(tmpdir()), "fortipi-image-context-"));
  try {
    const kitPath = resolve(downloaded, "sources-and-notices.tar");
    const kit = await verifySourceKit(
      { kit: kitPath, kitSha256: digest(image.sourceKitSha256), commit: source },
      resolve(temporary, "verified-kit"),
    );
    const expected = new Map<string, string>([
      [
        "Dockerfile",
        sha256(await regularBytes(resolve(repository, "apps/worker/container/Dockerfile"))),
      ],
      ["computerd", kit.embedded.binarySha256],
      ...kit.freeze.packages.map((pkg): [string, string] => [
        `packages/${pkg.name}.deb`,
        pkg.sha256,
      ]),
      ...Object.entries(kit.notices).map(([name, hash]): [string, string] => [
        `notices/${name}`,
        hash,
      ]),
    ]);
    const directories = new Set<string>([""]);
    for (const name of expected.keys()) {
      safePath(name);
      const parts = name.split("/");
      while (parts.length > 1) {
        parts.pop();
        directories.add(parts.join("/"));
      }
    }
    const checkContext = async (root: string, prefix = ""): Promise<Set<string>> => {
      const directory = resolve(root, prefix);
      const stat = await lstat(directory);
      assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
      const found = new Set<string>();
      for (const name of await readdir(directory)) {
        const path = prefix ? `${prefix}/${name}` : name;
        safePath(path);
        const filename = resolve(root, path);
        if (directories.has(path)) {
          for (const member of await checkContext(root, path)) found.add(member);
        } else {
          assert.ok(expected.has(path), "Unexpected qualified image input");
          const file = await lstat(filename);
          assert.ok(file.isFile() && !file.isSymbolicLink() && file.nlink === 1);
          assert.ok(file.size <= (path === "computerd" ? 200_000_000 : 32_000_000));
          assert.equal(
            await hashFile(filename),
            expected.get(path),
            "Qualified image input differs",
          );
          found.add(path);
        }
      }
      return found;
    };
    const context = resolve(downloaded, "context");
    assert.deepEqual((await checkContext(context)).size, expected.size, "Incomplete image inputs");
    await mkdir(output, { recursive: true });
    await writeFile(resolve(output, "image-metadata.json"), metadata, { flag: "wx" });
    await cp(context, resolve(output, "context"), {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    assert.equal((await checkContext(resolve(output, "context"))).size, expected.size);
    await copyFile(
      resolve(kit.directory, "source-revision.json"),
      resolve(output, "source-revision.json"),
      1,
    );
    await copyFile(kitPath, resolve(output, "sources-and-notices.tar"), 1);
    assert.equal(await hashFile(resolve(output, "sources-and-notices.tar")), kit.sourceKitSha256);
    await materializeSourceKitInventory(
      { kit: resolve(output, "sources-and-notices.tar"), kitSha256: string(image.sourceKitSha256) },
      resolve(output, "source-kit-inventory.json"),
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
export async function aggregateNative(
  candidatePath: string,
  input: string,
  out: string,
): Promise<void> {
  // Aggregation consumes only bounded identity metadata and small native result
  // files. Parsing or reconstructing package archives here adds no evidence.
  const loaded = await candidateMetadata(candidatePath);
  const context = await resolveCandidateReadContext(candidatePath);
  await authenticateCandidateRead(loaded, context);
  await mkdir(out, { mode: 0o700 });
  const claims: GateReceipt["claims"] = [];
  const platforms: GateReceipt["platforms"] = [];
  let oldest: string | undefined;
  for (const entry of await readdir(input)) {
    safePath(entry);
    const from = resolve(input, entry);
    const gate = await readJson(resolve(from, "gate.json"));
    assertGate(gate);
    assert.equal(gate.kind, "native");
    freshness(gate.checkedAt, 24);
    if (!oldest || Date.parse(gate.checkedAt) < Date.parse(oldest)) oldest = gate.checkedAt;
    assert.equal(gate.candidateSha256, loaded.hash);
    assert.equal(gate.sourceCommit, loaded.candidate.sourceCommit);
    assert.equal(gate.scope, loaded.candidate.scope);
    await verifyPayload(from, gate.files, ["gate.json"]);
    assert.equal(gate.platforms.length, 1);
    const platform = gate.platforms[0];
    assert.ok(platform && !platforms.includes(platform));
    platforms.push(platform);
    const claim = gate.claims.find((c) => c.id === "portable-daemon");
    assert.ok(claim && claim.outcome === "pass", "Missing actual native daemon result");
    await cp(from, resolve(out, platform), { recursive: true, errorOnExist: true, force: false });
    claims.push({
      ...claim,
      id: `portable-daemon-${platform}`,
      result: { ...claim.result, path: `${platform}/${claim.result.path}` },
    });
  }
  assert.deepEqual([...platforms].sort(), ["darwin", "linux", "win32"]);
  const files = await inventory(out);
  // ZIP transport normalizes regular-file modes. Bind aggregate claims to the verified
  // copied inventory while preserving each original receipt and result byte-for-byte.
  for (const claim of claims) {
    const actual = files.find((file) => file.path === claim.result.path);
    assert.ok(actual);
    assert.equal(actual.size, claim.result.size);
    assert.equal(actual.sha256, claim.result.sha256);
    claim.result = actual;
  }
  assert.ok(oldest);
  const gate: GateReceipt = {
    schemaVersion: 1,
    kind: "native",
    candidateSha256: loaded.hash,
    sourceCommit: loaded.candidate.sourceCommit,
    scope: loaded.candidate.scope,
    producer: await producer(repository, true),
    checkedAt: oldest,
    claims,
    platforms,
    deployments: [],
    files,
  };
  // Aggregation is not a new daemon observation, including time spent awaiting its producer.
  freshness(gate.checkedAt, 24);
  assertGate(gate);
  await saveJson(resolve(out, "gate.json"), gate);
}
if (import.meta.main) {
  try {
    const args = cliArgs();
    const operation = process.argv[2];
    if (operation === "candidate")
      console.log(
        JSON.stringify(
          await prepareCandidate({
            version: string(args.version),
            commitSha: string(args["commit-sha"]),
            scope: string(args.scope),
          }),
        ),
      );
    else if (operation === "publish")
      await publishCandidate(
        string(args.candidate),
        string(args.proofs),
        string(args.journal),
        string(args.confirm),
        string(args.readiness),
        args["prior-journal"],
      );
    else if (operation === "evidence") {
      assert.ok(["local", "native", "live"].includes(string(args.mode)));
      await runEvidence(
        args.mode as "local" | "native" | "live",
        string(args.candidate),
        string(args.fixture),
        string(args.out),
        args.deployment,
      );
    } else if (operation === "retained-evidence") {
      assert.equal(process.env.GITHUB_ACTIONS, "true");
      assert.equal(process.env.GITHUB_EVENT_NAME, "workflow_dispatch");
      assert.equal(process.env.GITHUB_REF, "refs/heads/main");
      const loaded = await loadCandidate(string(args.candidate), {
        reference: object(await readJson(string(args.reference))) as unknown as ArtifactReference,
        request: githubRequest(process.env.GITHUB_TOKEN),
      });
      assert.equal(process.env.GITHUB_SHA, loaded.candidate.sourceCommit);
      await privilegedCheckout(loaded.candidate);
      const current = await evidenceProducer(repository, loaded.candidate, "local");
      assert.equal(current.workflowPath, ".github/workflows/ci.yml");
      await writeFile(
        string(process.env.GITHUB_OUTPUT),
        `artifact=integrated-${loaded.candidate.sourceCommit}-${loaded.candidate.scope}-${current.runId}-${current.runAttempt}\n`,
        { flag: "a" },
      );
    } else if (operation === "install")
      console.log(
        JSON.stringify(await installCandidate(string(args.candidate), string(args.directory))),
      );
    else if (operation === "image")
      await prepareImage(string(args.descriptor), string(args.downloaded));
    else if (operation === "aggregate-native")
      await aggregateNative(string(args.candidate), string(args.input), string(args.out));
    else if (operation === "descriptor") {
      const variable =
        args.kind === "image"
          ? "IMAGE_REFERENCE"
          : args.kind === "target"
            ? "TARGET_REFERENCE"
            : args.kind === "previous"
              ? "PREVIOUS_REFERENCE"
              : args.kind === "targets"
                ? "TARGETS_REFERENCE"
                : args.kind === "journal"
                  ? "JOURNAL_REFERENCE"
                  : args.kind === "candidate"
                    ? "CANDIDATE_REFERENCE"
                    : undefined;
      assert.ok(variable);
      const value = JSON.parse(string(process.env[variable], 60000));
      if (args.kind === "targets") assert.ok(Array.isArray(value));
      else object(value);
      const scan = (item: unknown) => {
        if (Array.isArray(item)) item.forEach(scan);
        else if (item && typeof item === "object")
          for (const [key, entry] of Object.entries(item)) {
            assert.ok(
              !/^(?:token|password|privateKey|apiKey|authorization|secret|accountId|account_id|cloudflareAccountId)$/i.test(
                key,
              ),
              "Credential material forbidden in dispatch data",
            );
            scan(entry);
          }
      };
      scan(value);
      if (args.kind === "target") {
        const module: typeof import("./deploy-smoke.ts") = await import("./deploy-smoke.ts");
        module.assertTarget(value);
      }
      if (args.kind === "targets") {
        const module: typeof import("./deploy-smoke.ts") = await import("./deploy-smoke.ts");
        for (const descriptor of value) module.assertTarget(object(descriptor).target);
      }
      await saveJson(string(args.out), value);
    } else if (operation === "outputs") {
      const receipt = object(await readJson(string(args.receipt)));
      const manifestPath = string(receipt.candidateManifestPath);
      const loaded = await loadCandidate(manifestPath);
      assert.equal(loaded.hash, receipt.candidateSha256);
      const output = string(process.env.GITHUB_OUTPUT);
      await writeFile(
        output,
        `manifest=${manifestPath}\ndirectory=${dirname(manifestPath)}\nartifact=candidate-${loaded.candidate.sourceCommit}-${loaded.candidate.scope}-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}\n`,
        { flag: "a" },
      );
    } else if (operation === "check") {
      const { candidate, hash } = await loadCandidate(string(args.candidate));
      if (args.privileged === "true") {
        await privilegedCheckout(candidate);
        await trustedMain(candidate, githubRequest(process.env.GITHUB_TOKEN));
      }
      console.log(
        JSON.stringify({
          schemaVersion: 1,
          candidateSha256: hash,
          sourceCommit: candidate.sourceCommit,
          scope: candidate.scope,
        }),
      );
    } else throw new Error("Expected candidate, check, evidence or publish");
  } catch {
    console.error(
      "Release operation failed; required source, identity, artifact or proof is unavailable/invalid. No authorization inferred.",
    );
    process.exitCode = 1;
  }
}
