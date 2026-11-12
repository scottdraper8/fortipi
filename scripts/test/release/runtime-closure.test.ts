import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { Parser } from "tar";
import { archive } from "../../../tools/unstale/review-supply-chain.ts";
import { repository } from "../../build-workspaces.ts";
import {
  assertTrustedRuntimeClosure,
  assertTrustedRuntimePlan,
  collectRuntimeClosure,
  createRuntimeBundle,
  createRuntimeLayout,
  reverifyRuntimeLayout,
  runtimeClosureDigest,
  runtimeFileTotal,
} from "../../runtime-closure.ts";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

test("real frozen archives/patches and supported deploy preserve all owners and six separate version addresses", {
  timeout: 180_000,
}, async () => {
  const closure = await collectRuntimeClosure(repository);
  assertTrustedRuntimeClosure(closure);
  assert.equal(
    closure.inputs.lockSha256,
    hash(await readFile(resolve(repository, "pnpm-lock.yaml"))),
  );
  assert.equal(
    closure.inputs.reviewSha256,
    hash(await readFile(resolve(repository, "tools/unstale/supply-chain.json"))),
  );
  assert.throws(
    () => assertTrustedRuntimeClosure(JSON.parse(JSON.stringify(closure))),
    /trusted checkout/,
  );
  assert.ok(Object.isFrozen(closure) && Object.isFrozen(closure.archives));
  const patches = JSON.parse(
    await readFile(resolve(repository, "patches/review.json"), "utf8"),
  ) as Record<
    string,
    {
      files: Record<string, { patchedSha256: string }>;
    }
  >;
  for (const [id, patch] of Object.entries(patches)) {
    const source = closure.archives.find((value) => value.id === id);
    assert.ok(source);
    for (const [path, identity] of Object.entries(patch.files))
      assert.equal(source.files.find((file) => file.path === path)?.sha256, identity.patchedSha256);
  }
  const tui = closure.archives.find((value) => value.id === "@earendil-works/pi-tui@1.5.2");
  assert.ok(
    tui?.externalNative && tui.nativeFiles.length > 0,
    "Mixed native packages cannot become bundled JS",
  );
  const alias = closure.archives.find((value) => value.id === "agent-base@7.1.4");
  assert.ok(alias);
  assert.ok(alias.sourceAliases.some((value) => value.path === "dist/index.js"));
  assert.equal(alias.files.filter((file) => file.path === "dist/index.js").length, 1);
  assert.throws(
    () =>
      runtimeFileTotal([
        { path: "x", size: Number.MAX_SAFE_INTEGER, mode: 0o644, sha256: "a".repeat(64) },
        { path: "y", size: 1, mode: 0o644, sha256: "b".repeat(64) },
      ]),
    /overflow/,
  );
  const directory = await mkdtemp(resolve(tmpdir(), "fortipi-real-runtime-layout-"));
  try {
    let cli: Awaited<ReturnType<typeof createRuntimeLayout>> | undefined;
    for (const owner of closure.owners) {
      const layout = await createRuntimeLayout(
        closure,
        owner.sourceName,
        resolve(directory, owner.sourceName),
      );
      assert.equal(layout.closureSha256, runtimeClosureDigest(closure));
      assert.equal(
        layout.publicationReady,
        false,
        "A source layout is not retained archive authority",
      );
      if (owner.sourceName === "fortipi-cli") cli = layout;
    }
    assert.ok(cli);
    const actualCli = cli;
    // Independent exact-version oracle from the approved distribution review.
    for (const [name, versions] of [
      ["@smithy/node-http-handler", ["4.12.1", "4.14.2"]],
      ["@aws-sdk/token-providers", ["3.1127.0", "3.1166.0"]],
      ["https-proxy-agent", ["7.0.6", "9.1.0"]],
      ["agent-base", ["7.1.4", "9.0.0"]],
      ["ws", ["8.21.0", "8.22.2"]],
      ["undici", ["7.30.1", "8.12.4"]],
    ] as const) {
      const instances: ((typeof actualCli.instances)[number] | undefined)[] = versions.map(
        (version) =>
          actualCli.instances.find(
            (instance) => instance.context.split("(")[0] === `${name}@${version}`,
          ),
      );
      assert.ok(instances.every(Boolean), `Missing actual duplicate-version instance: ${name}`);
      assert.notEqual(
        instances[0]?.directory,
        instances[1]?.directory,
        `Conflated actual addresses: ${name}`,
      );
    }
    const patched = closure.archives.find((value) => value.name === "@earendil-works/pi-ai");
    assert.ok(patched?.patch);
    const patchedPath = Object.keys(patched.patch.files)[0]!;
    const patchedInstance = cli.instances.find(
      (instance) => instance.context.split("(")[0] === patched.id,
    );
    assert.ok(patchedInstance);
    const raw = await archive(patched.name, patched.version, patched.integrity, repository);
    assert.equal(hash(raw), patched.archiveSha256);
    let originalPatchInput: Buffer | undefined;
    await new Promise<void>((accept, reject) => {
      const parser = new Parser({
        onReadEntry(entry) {
          const chunks: Buffer[] = [];
          if (entry.path.split("/").slice(1).join("/") !== patchedPath) {
            entry.resume();
            return;
          }
          entry.on("data", (chunk: Buffer) => chunks.push(chunk));
          entry.on("end", () => {
            originalPatchInput = Buffer.concat(chunks);
          });
        },
      });
      parser.on("error", reject);
      parser.on("end", accept);
      parser.end(raw);
    });
    assert.ok(originalPatchInput);
    assert.equal(hash(originalPatchInput), patched.patch.files[patchedPath]!.originalSha256);
    const patchedFile = resolve(cli.directory, patchedInstance.directory, patchedPath);
    const actualPatched = await readFile(patchedFile);
    await writeFile(`${patchedFile}.missing-patch`, originalPatchInput, {
      flag: "wx",
      mode: 0o644,
    });
    await rename(`${patchedFile}.missing-patch`, patchedFile);
    await assert.rejects(reverifyRuntimeLayout(cli), /Producer bytes differ/);
    await writeFile(`${patchedFile}.restore`, actualPatched, { flag: "wx", mode: 0o644 });
    await rename(`${patchedFile}.restore`, patchedFile);
    const target = cli.instances.find((instance) => instance.context === "agent-base@7.1.4");
    assert.ok(target);
    const path = resolve(cli.directory, target.directory, "dist/index.js");
    const original = await readFile(path);
    const changed = Buffer.from(original);
    changed[0] = changed[0]! ^ 1;
    // Replace the controlled file inode: never mutate a content-store hardlink.
    await writeFile(`${path}.changed`, changed, { flag: "wx", mode: 0o644 });
    await rename(`${path}.changed`, path);
    await assert.rejects(reverifyRuntimeLayout(cli), /Producer bytes differ/);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("supported ordinary packs authenticate final dependency paths and preserve six duplicate-version groups", {
  timeout: 240_000,
}, async (t) => {
  const closure = await collectRuntimeClosure(repository);
  const directory = await mkdtemp(resolve(tmpdir(), "fortipi-real-runtime-packs-"));
  try {
    for (const owner of closure.owners) {
      const bundle = await createRuntimeBundle(
        closure,
        owner.sourceName,
        resolve(directory, owner.sourceName),
      );
      const plan = bundle.plan;
      assertTrustedRuntimePlan(plan);
      assert.throws(
        () => assertTrustedRuntimePlan(JSON.parse(JSON.stringify(plan))),
        /authenticated source/,
      );
      assert.equal(plan.publicationReady, false);
      assert.equal(
        plan.totalBytes,
        plan.files.reduce((sum, file) => sum + file.size, 0),
      );
      assert.ok(
        !plan.files.some((file) => /\.(?:node|dylib|dll|so(?:\.\d+)*|exe)$/i.test(file.path)),
      );
      assert.ok(
        !plan.files.some(
          (file) =>
            file.path.includes("/fortipi-contract/") || file.path.includes("/fortipi-client/"),
        ),
        "Owned Contract/Client dependencies stay external and shared",
      );
      assert.ok(
        plan.files.every(
          (file) => file.path.startsWith("node_modules/") && !file.path.includes("/.pnpm/"),
        ),
      );
      for (const [name, version] of Object.entries(plan.externalNative))
        assert.ok(
          closure.archives.some(
            (source) => source.name === name && source.version === version && source.externalNative,
          ),
        );
      if (owner.sourceName === "fortipi-cli") {
        for (const [name, versions] of [
          ["@smithy/node-http-handler", ["4.12.1", "4.14.2"]],
          ["@aws-sdk/token-providers", ["3.1127.0", "3.1166.0"]],
          ["https-proxy-agent", ["7.0.6", "9.1.0"]],
          ["agent-base", ["7.1.4", "9.0.0"]],
          ["ws", ["8.21.0", "8.22.2"]],
          ["undici", ["7.30.1", "8.12.4"]],
        ] as const) {
          const paths = versions.map(
            (version) =>
              plan.addresses.find((item) => item.context.split("(")[0] === `${name}@${version}`)
                ?.path,
          );
          assert.ok(paths.every(Boolean), `Missing published exact-version address: ${name}`);
          assert.notEqual(paths[0], paths[1]);
        }
        assert.ok(
          plan.blockedConveyancePaths.some((path) =>
            path.includes("/@anthropic-ai/sdk/lib/credentials/"),
          ),
          "Existing path policy remains explicitly unresolved; the source plan is not a waiver",
        );
      }
      t.diagnostic(
        JSON.stringify({
          sourceName: owner.sourceName,
          files: plan.files.length,
          bytes: plan.totalBytes,
          addresses: plan.addresses.length,
          producerPack: bundle.producerPack,
        }),
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
