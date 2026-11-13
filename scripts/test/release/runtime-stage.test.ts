import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { repository } from "../../build-workspaces.ts";
import { rewritePublishNames } from "../../rewrite-publish-names.ts";
import { collectRuntimeClosure, createRuntimeBundle } from "../../runtime-closure.ts";
import { bundledManifest, copyRuntimeMembers } from "../../stage-runtime-bundle.ts";
import { inventory, object, readJson } from "../../verify-release-gates.ts";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

test("actual controlled bundles preserve scoped owned edges, exact producer anchors and physical member bytes", {
  timeout: 240000,
}, async () => {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), "fortipi-runtime-stage-")));
  try {
    const closure = await collectRuntimeClosure(repository);
    const destination = resolve(root, "stage");
    await rewritePublishNames({
      root: repository,
      destination,
      scope: "fortipi-ci-test",
      version: "0.1.0",
    });
    await mkdir(resolve(root, "producer"));
    for (const owner of closure.owners) {
      const bundle = await createRuntimeBundle(
        closure,
        owner.sourceName,
        resolve(root, "producer", owner.sourceName),
      );
      const stage = resolve(destination, owner.sourceName);
      const original = object(await readJson(resolve(stage, "package.json")));
      const manifest = bundledManifest(closure, bundle.plan, original);
      const producer = object(await readJson(resolve(bundle.directory, "package.json")));
      const external = (value: unknown) =>
        Object.fromEntries(
          Object.entries(object(value ?? {})).filter(
            ([name]) =>
              !name.startsWith("fortipi-") && !name.startsWith("@fortipi-ci-test/fortipi-"),
          ),
        );
      assert.deepEqual(external(manifest.dependencies), external(producer.dependencies));
      assert.deepEqual(manifest.optionalDependencies, producer.optionalDependencies);
      assert.deepEqual(manifest.bundleDependencies, producer.bundleDependencies);
      for (const name of owner.ownDependencies)
        assert.equal(object(manifest.dependencies)[`@fortipi-ci-test/${name}`], "0.1.0");
      assert.equal(manifest.name, original.name);
      assert.equal(manifest.version, original.version);
      await copyRuntimeMembers(closure, bundle.plan, bundle.directory, stage);
      for (const member of bundle.plan.files) {
        const path = resolve(stage, member.path);
        assert.equal(hash(await readFile(path)), member.sha256);
        assert.equal((await lstat(path)).mode & 0o777, member.mode);
      }
      if (bundle.plan.files.length) {
        await assert.rejects(
          inventory(stage),
          /Unsafe artifact path/,
          "General artifact inventory must remain strict",
        );
        const member = bundle.plan.files.find((file) => file.path.endsWith(".js"));
        assert.ok(member);
        const path = resolve(bundle.directory, member.path);
        const bytes = await readFile(path);
        const changed = Buffer.from(bytes);
        changed[0] = (changed[0] ?? 0) ^ 1;
        await writeFile(`${path}.changed`, changed, { flag: "wx" });
        await rename(`${path}.changed`, path); // Never mutate a shared content-store inode.
        const badStage = resolve(root, "bad", owner.sourceName);
        await mkdir(badStage, { recursive: true });
        await assert.rejects(
          copyRuntimeMembers(closure, bundle.plan, bundle.directory, badStage),
          /Controlled producer member changed/,
        );
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
