import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { once } from "node:events";
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
import { packagePaths, repository } from "./build-workspaces.ts";
import { generateNotices, type NoticeReceipt } from "./generate-notices.ts";
import { pnpmExecutable, verifyPnpmExecutable } from "./pnpm-executable.ts";
import { rewritePublishNames } from "./rewrite-publish-names.ts";
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
): Promise<ProcessResult> {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
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
  });
}
async function checked(
  command: string,
  args: string[],
  cwd: string,
  env = childEnvironment(),
  timeout = 300_000,
  progress = false,
): Promise<string> {
  const result = await execute(command, args, cwd, env, timeout, progress);
  assert.ok(
    result.code === 0 && !result.timedOut,
    `Required command failed: ${basename(command)} ${args[0] ?? ""}`,
  );
  return result.stdout;
}
export async function archiveInventory(
  path: string,
): Promise<{ entries: FileRecord[]; manifest: Record<string, unknown> }> {
  const entries: FileRecord[] = [];
  const seen = new Set<string>();
  let manifest: Record<string, unknown> | undefined;
  let total = 0;
  let failure: unknown;
  await listTar({
    file: path,
    strict: true,
    onReadEntry(entry) {
      try {
        assert.ok(
          entry.path.startsWith("package/") && !entry.linkpath,
          "Archive prefix/link rejected",
        );
        if (entry.path === "package/" && entry.type === "Directory") {
          entry.resume();
          return;
        }
        const local = safePath(entry.path.slice(8).replace(/\/$/, ""));
        assert.ok(!seen.has(local.toLowerCase()), "Duplicate normalized archive path");
        seen.add(local.toLowerCase());
        assert.ok(
          entry.type === "File" || entry.type === "Directory",
          "Special archive entry rejected",
        );
        if (entry.type === "Directory") {
          entry.resume();
          return;
        }
        total += entry.size;
        assert.ok(entry.size <= 32_000_000 && total <= 200_000_000, "Archive byte bound");
        const chunks: Buffer[] = [];
        entry.on("data", (chunk: Buffer) => chunks.push(chunk));
        entry.on("end", () => {
          try {
            const data = Buffer.concat(chunks);
            assert.equal(data.length, entry.size);
            const mode = (entry.mode ?? 0) & 0o777;
            assert.ok((mode & 0o022) === 0, "Writable archive mode");
            entries.push({ path: local, size: data.length, mode, sha256: sha256(data) });
            if (local === "package.json") manifest = object(JSON.parse(data.toString("utf8")));
          } catch (error) {
            failure = error;
          }
        });
      } catch (error) {
        failure = error;
        entry.resume();
      }
    },
  });
  if (failure) throw failure;
  assert.ok(manifest, "Missing package manifest");
  return { entries: entries.sort((a, b) => a.path.localeCompare(b.path, "en")), manifest };
}
export async function stageAndPack(
  root: string,
  output: string,
  scope: string,
  version: string,
): Promise<{ packages: CandidatePackage[]; assetManifestSha256: string }> {
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
    const pnpm = await pnpmExecutable();
    await verifyPnpmExecutable(pnpm, childEnvironment());
    const packages: CandidatePackage[] = [];
    for (const source of packageOrder) {
      const directory = resolve(temporary, "stage", `fortipi-${source}`);
      const result = object(
        JSON.parse(
          await checked(
            pnpm,
            [
              "--ignore-workspace",
              "--npmrc-auth-file",
              auth,
              "pack",
              "--json",
              "--pack-destination",
              output,
            ],
            directory,
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
      const packed = await archiveInventory(file);
      const expected = await inventory(directory);
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
      packages.push({
        name: String(packed.manifest.name),
        sourceName: `fortipi-${source}`,
        version,
        tarball: `packs/${filename}`,
        sha256: sha256(data),
        integrity: sha512(data),
        entries: packed.entries,
      });
    }
    return { packages, assetManifestSha256: stage.assetManifestSha256 };
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
): Promise<Producer> {
  const path = `.github/workflows/${workflowName}`;
  const result: Producer = {
    workflowPath: path,
    workflowSha256: sha256(await regularBytes(resolve(root, path))),
    workflowId: 0,
    runId: Number(process.env.GITHUB_RUN_ID ?? 0),
    runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT ?? 0),
  };
  if (publishable) {
    assert.equal(process.env.GITHUB_REPOSITORY, REPOSITORY);
    assert.equal(process.env.GITHUB_REF, "refs/heads/main");
    assert.equal(process.env.GITHUB_EVENT_NAME, "workflow_dispatch");
    result.workflowId = integer(
      object(
        await githubRequest(process.env.GITHUB_TOKEN)(
          `/repos/${REPOSITORY}/actions/workflows/${workflowName}`,
        ),
      ).id,
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
  request = githubRequest(process.env.GITHUB_TOKEN),
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
    assert.equal(candidate.publishable, true);
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
export function evidenceEnvironment(producer: Producer, mode: "local" | "native" | "live") {
  return childEnvironment({
    FORTIPI_EVIDENCE_PRODUCER: canonicalJson(producer),
    ...(mode === "live" ? { FORTIPI_ADMIN_TOKEN: process.env.FORTIPI_ADMIN_TOKEN } : {}),
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
    await checked(pnpm, ["run", "build"], root, childEnvironment(), 600000, true);
    assert.equal(
      object(
        await readJson(resolve(root, "packages/fortipi-cli/worker-assets/asset-manifest.json")),
      ).sourceCommit,
      options.commitSha,
      "Embedded assets must be built at this candidate source",
    );
    const compatibility = await execute(
      process.execPath,
      [
        "tools/compatibility-watch/watch.ts",
        ...(process.env.GITHUB_ACTIONS === "true" ? [] : ["--gh"]),
      ],
      root,
      childEnvironment({ GITHUB_TOKEN: process.env.GITHUB_TOKEN }),
      180000,
    );
    await saveJson(resolve(destination, "compatibility.json"), JSON.parse(compatibility.stdout));
    assert.equal(
      compatibility.code,
      0,
      "Compatibility watch requires review at this candidate SHA",
    );
    const notices = await generateNotices(root);
    for (const args of [
      ["run", "typecheck"],
      ["run", "lint"],
      ["run", "schema:check"],
      ["run", "check:pins"],
      ["run", "check:licenses"],
      ["run", "unstale:check"],
      ["run", "test"],
    ])
      await checked(pnpm, args, root, childEnvironment(), 900000, true);
    await checked("pre-commit", ["run", "--all-files"], root, childEnvironment(), 600000, true);
    const packed = await stageAndPack(
      root,
      resolve(destination, "packs"),
      options.scope,
      options.version,
    );
    await generateSbom(root, destination, options.scope, options.version, notices);
    for (const file of [
      "openapi.yaml",
      ...(await inventory(resolve(root, "packages/fortipi-contract/schemas"))).map(
        (f) => `schemas/${f.path}`,
      ),
    ])
      await copy(root, `packages/fortipi-contract/${file}`, resolve(destination, "spec", file));
    for (const notice of notices)
      for (const file of [
        "LICENSE",
        "THIRD_PARTY_NOTICES.md",
        ...(await inventory(resolve(root, notice.directory, "licenses"))).map(
          (f) => `licenses/${f.path}`,
        ),
      ])
        await copy(
          root,
          `${notice.directory}/${file}`,
          resolve(destination, "legal", notice.package, file),
        );
    for (const file of [
      "image-metadata.json",
      "source-kit-inventory.json",
      "source-revision.json",
      "sources-and-notices.tar",
    ])
      await copy(root, `apps/worker/dist/container/${file}`, resolve(destination, "image", file));
    for (const file of ["inventory.json", "advisory-review.json"])
      await copy(root, `dist/supply-chain/${file}`, resolve(destination, "supply-chain", file));
    const image = object(await readJson(resolve(destination, "image/image-metadata.json")));
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
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}
export async function loadCandidate(
  path: string,
): Promise<{ candidate: CandidateManifest; hash: string; directory: string }> {
  const data = await regularBytes(path);
  const candidate: unknown = JSON.parse(data.toString("utf8"));
  assertCandidate(candidate);
  assert.equal(
    data.toString("utf8"),
    `${canonicalJson(candidate)}\n`,
    "Noncanonical candidate bytes",
  );
  const directory = dirname(resolve(path));
  await verifyPayload(directory, candidate.files, ["candidate.json"]);
  for (const p of candidate.packages) {
    const bytes = await regularBytes(resolve(directory, p.tarball));
    assert.equal(sha256(bytes), p.sha256);
    assert.equal(sha512(bytes), p.integrity);
    const packed = await archiveInventory(resolve(directory, p.tarball));
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
  return { candidate, hash: sha256(data), directory };
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
  const { candidate, hash, directory } = await loadCandidate(path);
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
export async function runEvidence(
  mode: "local" | "native" | "live",
  candidate: string,
  fixture: string,
  out: string,
  deployment?: string,
): Promise<void> {
  const loaded = await loadCandidate(candidate);
  const expectedProducer = await evidenceProducer(repository, loaded.candidate, mode);
  await regularBytes(resolve(repository, "tests/clients/run-evidence.ts"));
  assert.ok(
    resolve(fixture).startsWith(`${resolve(repository, "tests/clients/fixtures")}${sep}`) &&
      fixture.endsWith(".json"),
    "Evidence fixture must be a trusted source descriptor",
  );
  await regularBytes(resolve(fixture));
  const env = evidenceEnvironment(expectedProducer, mode);
  await checked(
    process.execPath,
    [
      "tests/clients/run-evidence.ts",
      mode,
      "--candidate",
      resolve(candidate),
      ...(deployment ? ["--deployment", resolve(deployment)] : []),
      "--fixture",
      resolve(fixture),
      "--out",
      resolve(out),
    ],
    repository,
    env,
    900000,
    true,
  );
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
): Promise<{ consumer: string; cliBin: string; candidateSha256: string }> {
  const { candidate, hash, directory } = await loadCandidate(path);
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
      const { manifest } = await archiveInventory(resolve(directory, pkg.tarball));
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
/** Recreate the qualified source context using the actual image producer's source, never relabel its runtime. */
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
  assert.equal(artifact.name, `container-evidence-rootless-${source}-${runId}-${attempt}`);
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
  const metadata = await regularBytes(resolve(downloaded, "image-metadata.json"));
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
  const temporary = await mkdtemp(resolve(await realpath(tmpdir()), "fortipi-image-context-"));
  const checkout = resolve(temporary, "source");
  await git("worktree", "add", "--detach", checkout, source);
  try {
    await checked(
      process.execPath,
      ["scripts/install-dependencies.ts"],
      checkout,
      childEnvironment(),
      600000,
      true,
    );
    const pnpm = await pnpmExecutable();
    await checked(
      pnpm,
      ["--dir", "tools/unstale", "install", "--frozen-lockfile"],
      checkout,
      childEnvironment(),
      300000,
      true,
    );
    await checked(
      process.execPath,
      ["apps/worker/container/build.ts", "--prepare"],
      checkout,
      childEnvironment(),
      1200000,
      true,
    );
    const generated = resolve(checkout, "apps/worker/dist/container");
    assert.equal(
      sha256(await regularBytes(resolve(generated, "sources-and-notices.tar"))),
      image.sourceKitSha256,
      "Recreated source kit differs from qualified image",
    );
    const output = resolve(repository, "apps/worker/dist/container");
    await mkdir(output, { recursive: true });
    await writeFile(resolve(output, "image-metadata.json"), metadata, { flag: "wx" });
    for (const file of [
      "context",
      "source-kit-inventory.json",
      "source-revision.json",
      "sources-and-notices.tar",
    ])
      await cp(resolve(generated, file), resolve(output, file), {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
  } finally {
    await git("worktree", "remove", "--force", checkout);
    await rm(temporary, { recursive: true, force: true });
  }
}
export async function aggregateNative(
  candidatePath: string,
  input: string,
  out: string,
): Promise<void> {
  const loaded = await loadCandidate(candidatePath);
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
      const loaded = await loadCandidate(string(args.candidate));
      assert.equal(process.env.GITHUB_SHA, loaded.candidate.sourceCommit);
      await privilegedCheckout(loaded.candidate);
      await verifyRetainedCandidate(
        loaded.candidate,
        loaded.hash,
        object(await readJson(string(args.reference))) as unknown as ArtifactReference,
        githubRequest(process.env.GITHUB_TOKEN),
      );
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
