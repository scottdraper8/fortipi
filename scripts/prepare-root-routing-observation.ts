// Explicit one-time, local installed-source overlay. Never an installer hook.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";
import { routingHeader, routingPrefix, routingStages } from "./root-routing-observation.ts";

const root = resolve(import.meta.dirname, "..");
export const proxyOriginalSha256 =
  "164d7fef07c6732e1efc983bcb1953da2e6f356a8e7d0e9a05cc004c0a5d0875";
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const marker = "/* FORTIPI_ROOT_ROUTING */";
// Probe's marker carries the original public flag1 across the two runtime hops.
export const routingProducer = `${marker}\nlet __fortipiRoutingMask = 0;\nfunction __fortipiRoute(request, stage) {\n  try {\n    if (request.headers.get(${JSON.stringify(routingHeader)}) !== "1") return;\n    const path = new URL(request.url).pathname;\n    if (path !== "/__test/ping" && path !== "/health") return;\n    const index = ${JSON.stringify(routingStages)}.indexOf(stage);\n    if (index < 0 || (__fortipiRoutingMask & (1 << index))) return;\n    __fortipiRoutingMask |= 1 << index;\n    console.log(${JSON.stringify(routingPrefix)} + stage);\n  } catch {}\n}\n${marker}\n`;
const proxyEdits: [string, string][] = [
  [
    "  fetch(req, env) {\n    const singleton",
    '  fetch(req, env) {\n    __fortipiRoute(req, "proxy-accepted");\n    const singleton',
  ],
  [
    "    const deferred = createDeferred();",
    '    if (this.proxyData === void 0) __fortipiRoute(request, "proxy-config-wait");\n    const deferred = createDeferred();',
  ],
  [
    "      this.requestRetryQueue.delete(request);",
    '      __fortipiRoute(request, "proxy-config-present");\n      this.requestRetryQueue.delete(request);',
  ],
  [
    "=> void fetch(userWorkerUrl, new Request(request, { headers })).then(",
    '=> void (__fortipiRoute(request, "proxy-forward"), fetch(userWorkerUrl, new Request(request, { headers }))).then(',
  ],
  [
    "        async (res) => {",
    '        async (res) => {\n          __fortipiRoute(request, "proxy-upstream-response");',
  ],
];
function one(source: string, from: string, to: string) {
  assert.equal(source.split(from).length, 2, "Diagnostic source anchor must occur exactly once");
  return source.replace(from, to);
}
export function restoreRoutingProxy(source: string): string {
  let restored = source;
  if (source.startsWith(routingProducer)) {
    restored = one(restored, routingProducer, "");
    for (const [from, to] of proxyEdits) restored = one(restored, to, from);
  }
  assert.equal(hash(restored), proxyOriginalSha256, "Pinned original ProxyWorker source changed");
  return restored;
}
export function instrumentRoutingProxy(source: string): string {
  const original = restoreRoutingProxy(source);
  let changed = original;
  for (const [from, to] of proxyEdits) changed = one(changed, from, to);
  changed = routingProducer + changed;
  assert.equal(restoreRoutingProxy(changed), original);
  return changed;
}
export function instrumentRoutingFixture(path: string, source: string): string {
  if (path === resolve(root, "apps/worker/test/agent/runtime-worker.ts")) {
    const old = '    if (url.pathname === "/__test/ping") return new Response("ready");';
    const next =
      '    if (url.pathname === "/__test/ping") {\n      __fortipiRoute(request, "user-ping-enter");\n      const response = new Response("ready");\n      __fortipiRoute(request, "user-ping-return");\n      return response;\n    }';
    const result = routingProducer + one(source, old, next);
    assert.equal(one(one(result, routingProducer, ""), next, old), source);
    return result;
  }
  if (path === resolve(root, "apps/worker/src/api/router.ts")) {
    const old =
      '    if (route.owner === "discovery") return merge(discovery(route, path, env), exposed);';
    const next =
      '    if (route.owner === "discovery") {\n      __fortipiRoute(request, "user-ping-enter");\n      const response = merge(discovery(route, path, env), exposed);\n      __fortipiRoute(request, "user-ping-return");\n      return response;\n    }';
    const result = routingProducer + one(source, old, next);
    assert.equal(one(one(result, routingProducer, ""), next, old), source);
    return result;
  }
  return source;
}
async function atomic(path: string, bytes: string | Buffer, mode: number) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
export const cliOriginalSha256 = "014ebf6d5194abb1287998f5e6f5bda31104c34062d89dcccd1b7c6ad4967a71";
export const binOriginalSha256 = "d35986bcb0dc16bf6b9515fd2ba0d431b5705c80730702b764f0286a3b825414";
function bridge(originalPath: string, copyPath: string, copyHash: string) {
  // Compile at the original filename so __dirname, require paths and relative assets agree.
  // Only the two explicit diagnostic entrypoints use this bridge; no global loader hook.
  return `const fs = require("node:fs"), crypto = require("node:crypto"), path = require("node:path"), Module = require("node:module");\nconst filename = ${JSON.stringify(originalPath)};\nconst active = process.env.FORTIPI_ROOT_CONTEXT_DIAGNOSTICS === "1";\nconst text = fs.readFileSync(active ? ${JSON.stringify(copyPath)} : filename);\nif (active && crypto.createHash("sha256").update(text).digest("hex") !== ${JSON.stringify(copyHash)}) process.exit(92);\nconst entry = new Module(filename, null);\nentry.id = "."; entry.filename = filename; entry.paths = Module._nodeModulePaths(path.dirname(filename));\nprocess.argv[1] = filename; process.mainModule = entry; Module._cache[filename] = entry;\nentry._compile(text.toString("utf8"), filename);\n`;
}
export async function prepareRootRouting(restore = false) {
  if (process.env.FORTIPI_ROOT_CONTEXT_DIAGNOSTICS !== "1") return { enabled: false };
  const destination = resolve(root, ".agent-docs/tmp/root-routing");
  if (restore) {
    await rm(destination, { recursive: true, force: true });
    return { enabled: true, restored: true };
  }
  const require = createRequire(resolve(root, "apps/worker/package.json"));
  const wrangler = dirname(require.resolve("wrangler/package.json"));
  assert.equal(
    JSON.parse(await readFile(resolve(wrangler, "package.json"), "utf8")).version,
    "4.162.0",
  );
  const path = await realpath(resolve(wrangler, "wrangler-dist/ProxyWorker.js"));
  assert.ok(
    path.startsWith(`${root}/node_modules/`),
    "Only this worktree's installed graph may be used",
  );
  const stat = await lstat(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink());
  const original = await readFile(path, "utf8");
  assert.equal(hash(original), proxyOriginalSha256);
  const cliPath = resolve(wrangler, "wrangler-dist/cli.js"),
    binPath = resolve(wrangler, "bin/wrangler.js");
  const cli = await readFile(cliPath, "utf8"),
    bin = await readFile(binPath, "utf8");
  assert.equal(hash(cli), cliOriginalSha256);
  assert.equal(hash(bin), binOriginalSha256);
  await mkdir(destination, { recursive: true });
  const metadata: Record<string, string | number> = { version: 1 };
  for (const [kind, entry] of [
    ["process", "apps/worker/test/agent/runtime-worker.ts"],
    ["integration", "apps/worker/test/integration/fixture-worker.ts"],
  ] as const) {
    const result = await build({
      entryPoints: [resolve(root, entry)],
      bundle: true,
      write: false,
      format: "esm",
      platform: "neutral",
      mainFields: ["browser", "module", "main"],
      target: "es2024",
      conditions: ["workerd", "worker", "browser"],
      external: ["cloudflare:*", "node:*"],
      logLevel: "silent",
      plugins: [
        {
          name: "root-routing-fixture",
          setup(build) {
            build.onLoad({ filter: /(?:runtime-worker|router)\.ts$/ }, async (args) => ({
              contents: instrumentRoutingFixture(args.path, await readFile(args.path, "utf8")),
              loader: "ts",
              resolveDir: dirname(args.path),
            }));
          },
        },
      ],
    });
    assert.equal(result.outputFiles.length, 1);
    const bytes = result.outputFiles[0]?.contents;
    assert.ok(bytes && bytes.length <= 8_000_000);
    metadata[kind] = hash(Buffer.from(bytes));
    await atomic(resolve(destination, `${kind}.mjs`), Buffer.from(bytes), 0o644);
  }
  const proxyCopy = resolve(destination, "ProxyWorker.js"),
    cliCopy = resolve(destination, "cli-source.cjs"),
    binCopy = resolve(destination, "bin-source.cjs");
  const cliEntry = resolve(destination, "cli-entry.cjs"),
    binEntry = resolve(destination, "entry.cjs");
  const changedProxy = instrumentRoutingProxy(original);
  const cliAnchor =
    'scriptPath2 = path30__namespace.default.resolve(__dirname, "..", "wrangler-dist/ProxyWorker.js");';
  const changedCli = one(cli, cliAnchor, `scriptPath2 = ${JSON.stringify(proxyCopy)};`);
  assert.equal(one(changedCli, `scriptPath2 = ${JSON.stringify(proxyCopy)};`, cliAnchor), cli);
  const binAnchor = 'path.join(__dirname, "../wrangler-dist/cli.js"),';
  const changedBin = one(bin, binAnchor, `${JSON.stringify(cliEntry)},`);
  assert.equal(one(changedBin, `${JSON.stringify(cliEntry)},`, binAnchor), bin);
  await atomic(proxyCopy, changedProxy, 0o644);
  await atomic(cliCopy, changedCli, 0o644);
  await atomic(binCopy, changedBin, 0o644);
  await atomic(cliEntry, bridge(cliPath, cliCopy, hash(changedCli)), 0o644);
  const entry = bridge(binPath, binCopy, hash(changedBin));
  metadata.entry = hash(entry);
  await atomic(binEntry, entry, 0o644);
  await atomic(resolve(destination, "prepared.json"), `${JSON.stringify(metadata)}\n`, 0o600);
  assert.equal(hash(await readFile(path)), proxyOriginalSha256);
  assert.equal(hash(await readFile(cliPath)), cliOriginalSha256);
  assert.equal(hash(await readFile(binPath)), binOriginalSha256);
  return {
    enabled: true,
    restored: false,
    copies: 2,
    originalSha256: proxyOriginalSha256,
    installedUntouched: true,
  };
}

if (import.meta.main) {
  try {
    assert.ok(process.argv.slice(2).every((arg) => arg === "--restore"));
    console.log(JSON.stringify(await prepareRootRouting(process.argv.includes("--restore"))));
  } catch {
    console.error(JSON.stringify({ diagnostic: "root-routing-prepare", outcome: "refused" }));
    process.exitCode = 1;
  }
}
