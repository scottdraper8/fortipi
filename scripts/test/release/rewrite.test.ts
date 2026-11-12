import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test, { after, before } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { packagePaths, repository } from "../../build-workspaces.ts";
import {
  assertNoSourceReferences,
  rewriteModuleSource,
  rewritePublishNames,
  type StageReceipt,
} from "../../rewrite-publish-names.ts";

const run = promisify(execFile);
const scope = "fortipi-ci-test";
const names = Object.fromEntries(
  packagePaths.map((p) => {
    const name = p.slice("packages/".length);
    return [name, `@${scope}/${name}`];
  }),
);
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
let temporary: string;
let root: string;
let staged: string;
let receipt: StageReceipt;
async function inventory(root: string, prefix = ""): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const name of (await readdir(root)).sort()) {
    const path = resolve(root, name);
    const local = prefix ? `${prefix}/${name}` : name;
    const stat = await lstat(path);
    assert.ok(!stat.isSymbolicLink());
    if (stat.isDirectory()) Object.assign(result, await inventory(path, local));
    else result[local] = digest(await readFile(path));
  }
  return result;
}
before(async () => {
  temporary = await mkdtemp(resolve(await realpath(tmpdir()), "fortipi-namespace-"));
  root = resolve(temporary, "source");
  staged = resolve(temporary, "stage");
  await mkdir(root);
  for (const file of ["package.json", "LICENSE"])
    await cp(resolve(repository, file), resolve(root, file), { errorOnExist: true, force: false });
  for (const path of packagePaths) {
    const manifest = JSON.parse(
      await readFile(resolve(repository, path, "package.json"), "utf8"),
    ) as { files: string[] };
    await mkdir(resolve(root, path), { recursive: true });
    for (const file of ["package.json", ...manifest.files])
      await cp(resolve(repository, path, file), resolve(root, path, file), {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
  }
});
after(async () => {
  if (temporary) await rm(temporary, { recursive: true, force: true });
});

test("stages all five real compiled packages without modifying source or any embedded Worker byte", async () => {
  const before = await inventory(root);
  const command = resolve(repository, "scripts/rewrite-publish-names.ts");
  const imported = await run(
    process.execPath,
    ["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(command).href)})`],
    { cwd: temporary },
  );
  assert.equal(imported.stdout, "");
  assert.equal(imported.stderr, "");
  await assert.rejects(lstat(staged), { code: "ENOENT" });
  const result = await run(
    process.execPath,
    [command, "--root", root, "--destination", staged, "--scope", scope, "--version", "0.1.0"],
    { cwd: temporary, maxBuffer: 4 * 1024 * 1024 },
  );
  assert.equal(result.stderr, "");
  receipt = JSON.parse(result.stdout) as StageReceipt;
  assert.equal(receipt.schemaVersion, 1);
  assert.deepEqual(receipt.packages.map((p) => p.name).sort(), Object.values(names).sort());
  for (const path of packagePaths) {
    const name = path.slice("packages/".length);
    const stage = resolve(staged, name);
    const original = JSON.parse(await readFile(resolve(root, path, "package.json"), "utf8"));
    const output = JSON.parse(await readFile(resolve(stage, "package.json"), "utf8"));
    for (const field of [
      "type",
      "exports",
      "engines",
      "repository",
      "license",
      "publishConfig",
      "bin",
    ])
      assert.deepEqual(output[field], original[field]);
    assert.equal(output.name, names[name]);
    assert.equal(output.version, "0.1.0");
    assert.equal(output.scripts, undefined);
    assert.equal(output.devDependencies, undefined);
    for (const [dependency, version] of Object.entries(original.dependencies ?? {}))
      assert.equal(
        output.dependencies[names[dependency] ?? dependency],
        names[dependency] ? "0.1.0" : version,
      );
    assert.deepEqual(
      await readFile(resolve(stage, "LICENSE")),
      await readFile(resolve(root, "LICENSE")),
    );
    for (const file of ["THIRD_PARTY_NOTICES.md", "README.md"])
      assert.deepEqual(
        await readFile(resolve(stage, file)),
        await readFile(resolve(root, path, file)),
      );
    assert.deepEqual(
      await inventory(resolve(stage, "licenses")),
      await inventory(resolve(root, path, "licenses")),
    );
    const actual = await inventory(stage);
    const recorded = receipt.packages.find((p) => p.name === names[name]);
    assert.ok(recorded);
    assert.deepEqual(Object.fromEntries(recorded.files.map((p) => [p.path, p.sha256])), actual);
    for (const file of Object.keys(actual)) {
      if (file.startsWith("worker-assets/")) continue;
      assert.ok(!file.endsWith(".map"));
      if (/\.(?:[cm]?js|d\.[cm]?ts)$/.test(file))
        assertNoSourceReferences(await readFile(resolve(stage, file), "utf8"), file, names);
    }
  }
  const embedded = await inventory(resolve(staged, "fortipi-cli/worker-assets"));
  assert.deepEqual(embedded, await inventory(resolve(root, "packages/fortipi-cli/worker-assets")));
  assert.equal(embedded["asset-manifest.json"], receipt.assetManifestSha256);
  // Independent resolver oracle: real browser entry + real scoped contract, rejecting source aliases.
  const aliases = Object.fromEntries(
    await Promise.all(
      Object.entries(names).map(async ([source, name]) => {
        const metadata = JSON.parse(
          await readFile(resolve(staged, source, "package.json"), "utf8"),
        );
        return [name, resolve(staged, source, metadata.exports["."].import)];
      }),
    ),
  );
  const bundle = () =>
    build({
      entryPoints: [resolve(staged, "fortipi-client/dist/browser.js")],
      bundle: true,
      platform: "browser",
      format: "esm",
      write: false,
      logLevel: "silent",
      absWorkingDir: repository,
      nodePaths: [resolve(repository, "node_modules")],
      alias: aliases,
      plugins: [
        {
          name: "reject-source-namespace",
          setup(builder) {
            builder.onResolve(
              { filter: /^fortipi-(?:contract|client|tui|cli|executor)(?:\/|$)/ },
              (args) => ({ errors: [{ text: `Residual source import: ${args.path}` }] }),
            );
          },
        },
      ],
    });
  assert.ok((await bundle()).outputFiles[0]?.text.includes("class"));
  const executable = resolve(staged, "fortipi-client/dist/client.js");
  const correct = await readFile(executable, "utf8");
  const missed = correct.replace(`"@${scope}/fortipi-contract"`, '"fortipi-contract"');
  assert.notEqual(missed, correct);
  await writeFile(executable, missed);
  try {
    await assert.rejects(bundle(), /Residual source import: fortipi-contract/);
  } finally {
    await writeFile(executable, correct);
  }
  await bundle();
  const declarations = await readFile(
    resolve(staged, "fortipi-client/dist/resources.d.ts"),
    "utf8",
  );
  assert.ok(declarations.includes(`import("@${scope}/fortipi-contract").Health`));
  const broken = declarations.replace(
    `import("@${scope}/fortipi-contract").Health`,
    'import("fortipi-contract").Health',
  );
  assert.notEqual(broken, declarations);
  assert.throws(
    () => assertNoSourceReferences(broken, "resources.d.ts", names),
    /Residual source module/,
  );
  assert.deepEqual(
    await inventory(root),
    before,
    "Tracked-source equivalent inputs must remain byte identical",
  );
});

test("rewrites syntax positions in JS and all declaration extensions, preserving data and removing only outer maps", async () => {
  const js = `// fortipi-contract is documentation
import { x } from "fortipi-contr\\u0061ct";
export { y } from 'fortipi-client/node';
export * from "fortipi-tui";
const a = import("fortipi-cli");
const b = require('fortipi-executor/platform');
const c = require.resolve("fortipi-contract");
const d = import.meta.resolve('fortipi-client');
const e = createRequire(import.meta.url).resolve("fortipi-cli/config");
const data = "fortipi-contract";
const lookalike = import("fortipi-client-extra");
const vendor = require("@earendil-works/pi-ai");
//# sourceMappingURL=contexts.js.map
`;
  const expected = `// fortipi-contract is documentation
import { x } from "@fortipi-ci-test/fortipi-contract";
export { y } from "@fortipi-ci-test/fortipi-client/node";
export * from "@fortipi-ci-test/fortipi-tui";
const a = import("@fortipi-ci-test/fortipi-cli");
const b = require("@fortipi-ci-test/fortipi-executor/platform");
const c = require.resolve("@fortipi-ci-test/fortipi-contract");
const d = import.meta.resolve("@fortipi-ci-test/fortipi-client");
const e = createRequire(import.meta.url).resolve("@fortipi-ci-test/fortipi-cli/config");
const data = "fortipi-contract";
const lookalike = import("fortipi-client-extra");
const vendor = require("@earendil-works/pi-ai");

`;
  assert.equal(rewriteModuleSource(js, "contexts.mjs", names), expected);
  assert.equal(
    rewriteModuleSource('const m = require("fortipi-client/node");', "contexts.cjs", names),
    'const m = require("@fortipi-ci-test/fortipi-client/node");',
  );
  const declaration = `import X = require("fortipi-contract");
export type T = import('fortipi-client/node').Options;
declare module "fortipi-executor" { interface Extra {} }
declare const data: "fortipi-contract";
/// <reference types="node" />
/*# sourceMappingURL=contexts.d.ts.map */`;
  const dtsExpected = `import X = require("@fortipi-ci-test/fortipi-contract");
export type T = import("@fortipi-ci-test/fortipi-client/node").Options;
declare module "@fortipi-ci-test/fortipi-executor" { interface Extra {} }
declare const data: "fortipi-contract";
/// <reference types="node" />
`;
  for (const extension of ["d.ts", "d.mts", "d.cts"])
    assert.equal(rewriteModuleSource(declaration, `contexts.${extension}`, names), dtsExpected);
  const fixture = resolve(root, "packages/fortipi-contract/dist/contexts.js");
  await writeFile(fixture, js);
  await writeFile(`${fixture}.map`, '{"version":3}');
  const manifestPath = resolve(root, "packages/fortipi-contract/package.json");
  const original = await readFile(manifestPath);
  const manifest = JSON.parse(original.toString("utf8"));
  manifest.optionalDependencies = { "fortipi-client": "workspace:*" };
  manifest.peerDependencies = { "fortipi-tui": "workspace:*" };
  manifest.peerDependenciesMeta = { "fortipi-tui": { optional: true } };
  manifest.imports = { "#self": "fortipi-contract", "#client": "fortipi-client/node" };
  manifest.scripts = { prepack: "must never execute" };
  await writeFile(manifestPath, JSON.stringify(manifest));
  const destination = resolve(temporary, "contexts-stage");
  try {
    await rewritePublishNames({ root, destination, scope, version: "0.1.0" });
    assert.equal(
      await readFile(resolve(destination, "fortipi-contract/dist/contexts.js"), "utf8"),
      expected,
    );
    await assert.rejects(lstat(resolve(destination, "fortipi-contract/dist/contexts.js.map")), {
      code: "ENOENT",
    });
    const output = JSON.parse(
      await readFile(resolve(destination, "fortipi-contract/package.json"), "utf8"),
    );
    assert.deepEqual(output.optionalDependencies, { "@fortipi-ci-test/fortipi-client": "0.1.0" });
    assert.deepEqual(output.peerDependencies, { "@fortipi-ci-test/fortipi-tui": "0.1.0" });
    assert.deepEqual(output.peerDependenciesMeta, {
      "@fortipi-ci-test/fortipi-tui": { optional: true },
    });
    assert.deepEqual(output.imports, {
      "#self": "@fortipi-ci-test/fortipi-contract",
      "#client": "@fortipi-ci-test/fortipi-client/node",
    });
    assert.equal(output.scripts, undefined);
  } finally {
    await writeFile(manifestPath, original);
    await rm(fixture);
    await rm(`${fixture}.map`);
  }
});

test("fails closed on namespace, link, resolver and embedded-byte faults without retaining a partial candidate", async () => {
  const options = { root, destination: resolve(temporary, "rejected"), scope, version: "0.1.0" };
  for (const invalid of [
    { scope: "@wrong" },
    { version: "^0.1.0" },
    { version: "0.1.1" },
    { destination: resolve(root, "packages/stage") },
  ])
    await assert.rejects(rewritePublishNames({ ...options, ...invalid }));
  const retained = await inventory(staged);
  await assert.rejects(rewritePublishNames({ ...options, destination: staged }), {
    code: "EEXIST",
  });
  assert.deepEqual(await inventory(staged), retained);
  async function fault(path: string, edit: (original: Buffer) => Uint8Array, expected: RegExp) {
    const original = await readFile(path);
    await writeFile(path, edit(original));
    try {
      await assert.rejects(rewritePublishNames(options), expected);
      await assert.rejects(lstat(options.destination), { code: "ENOENT" });
    } finally {
      await writeFile(path, original);
    }
  }
  await fault(
    resolve(root, "package.json"),
    (original) => {
      const value = JSON.parse(original.toString("utf8"));
      value.fortipi.publishNames["fortipi-extra"] = "@{scope}/fortipi-extra";
      return Buffer.from(JSON.stringify(value));
    },
    /publication map drift/,
  );
  await fault(
    resolve(root, "packages/fortipi-client/package.json"),
    (original) => {
      const value = JSON.parse(original.toString("utf8"));
      value.dependencies.ajv = "^8.20.0";
      return Buffer.from(JSON.stringify(value));
    },
    /Nonexact dependency/,
  );
  await fault(
    resolve(root, "packages/fortipi-contract/dist/index.js"),
    (original) => Buffer.concat([original, Buffer.from("\nconst next = import(runtimeName);")]),
    /Computed module reference/,
  );
  const assetManifest = JSON.parse(
    await readFile(resolve(root, "packages/fortipi-cli/worker-assets/asset-manifest.json"), "utf8"),
  );
  await fault(
    resolve(root, "packages/fortipi-cli/worker-assets", assetManifest.entry),
    (original) => Buffer.concat([original, Buffer.from("\n")]),
    /asset_integrity_failed/,
  );
  const linked = resolve(root, "packages/fortipi-contract/dist/linked.js");
  await symlink(resolve(root, "LICENSE"), linked);
  try {
    await assert.rejects(rewritePublishNames(options), /Linked publication input/);
  } finally {
    await rm(linked);
  }
  const linkParent = resolve(temporary, "linked-parent");
  await symlink(temporary, linkParent);
  await assert.rejects(
    rewritePublishNames({ ...options, destination: resolve(linkParent, "escape") }),
    /Linked\/non-directory parent/,
  );
  for (const source of [
    "const x = require(name);",
    "const x = require.resolve(`fortipi-contract`);",
    "const x = import.meta.resolve(name);",
    'import x from "npm:fortipi-contract@0.1.0";',
    'import x from "@another/fortipi-contract";',
    '/// <reference types="fortipi-contract" />\nexport {};',
  ])
    assert.throws(() => rewriteModuleSource(source, "unsupported.d.ts", names));
  assert.throws(
    () => rewriteModuleSource('import x from "fortipi-contract";', "worker/index.js", names, true),
    /Unbundled internal Worker module/,
  );
  assert.equal(
    rewriteModuleSource("const loader = import(runtimeName);", "worker/index.js", names, true),
    "const loader = import(runtimeName);",
  );
});
