import assert from "node:assert/strict";
import { constants } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { after, before, test } from "node:test";
import { archiveEntries } from "../../../tools/unstale/review-supply-chain.ts";
import { packagePaths, repository } from "../../build-workspaces.ts";
import {
  assertRuntimeWasmMember,
  checkLicenses,
  type RuntimeConveyanceMember,
  reviewRuntimeConveyance,
} from "../../check-licenses.ts";
import { generateRuntimeNotices, type RuntimeNoticeReceipt } from "../../generate-notices.ts";
import {
  collectRuntimeClosure,
  createRuntimeBundle,
  type RuntimeClosure,
  type RuntimePhysicalPlan,
} from "../../runtime-closure.ts";
import { inventory, readJson, regularBytes, sha256 } from "../../verify-release-gates.ts";
import { temporary } from "./fixtures.ts";

let root: string, facts: string;
let closure: RuntimeClosure;
const plans = new Map<string, RuntimePhysicalPlan>();
before(async () => {
  root = await temporary("fortipi-runtime-legal-");
  facts = resolve(root, "facts");
  await mkdir(facts);
  // Independent mutable copies of public checked inputs; no canonical fixture mutation.
  for (const path of [
    "LICENSE",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "patches",
    "tools/unstale/supply-chain.json",
    "tools/unstale/license-policy.json",
    "tools/unstale/licenses",
    "apps/worker/container/embedded-freeze.json",
    "dist/supply-chain",
    ...packagePaths.map((path) => `${path}/package.json`),
  ]) {
    await mkdir(dirname(resolve(facts, path)), { recursive: true });
    await cp(resolve(repository, path), resolve(facts, path), {
      recursive: true,
      force: false,
      errorOnExist: true,
      mode: constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE,
    });
  }
  closure = await collectRuntimeClosure(repository);
  for (const owner of closure.owners) {
    const bundle = await createRuntimeBundle(
      closure,
      owner.sourceName,
      resolve(root, owner.sourceName),
    );
    plans.set(owner.sourceName, bundle.plan);
  }
});
after(async () => {
  if (root) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
function cliPlan() {
  const plan = plans.get("fortipi-cli");
  assert.ok(plan);
  return plan;
}

test("actual five supported packs produce source-bound staged legal files and per-context provenance without rewriting Worker/own notices", {
  timeout: 180000,
}, async () => {
  const worker = await inventory(
    resolve(repository, "packages/fortipi-cli/worker-assets/licenses"),
  );
  const own = await Promise.all(
    packagePaths.map((path) => regularBytes(resolve(repository, path, "THIRD_PARTY_NOTICES.md"))),
  );
  for (const [name, plan] of plans) {
    const output = resolve(root, `legal-${name}`);
    const receipt = await generateRuntimeNotices(facts, closure, plan, output);
    assert.equal(receipt.package, name);
    assert.equal(receipt.conveyance.planSha256, sha256(JSON.stringify(plan)));
    assert.equal(
      receipt.conveyance.rootLicenseSha256,
      sha256(await regularBytes(resolve(repository, "LICENSE"))),
    );
    assert.deepEqual(await inventory(output), receipt.files);
    assert.equal(
      receipt.conveyance.components.flatMap((item) => item.files).length,
      plan.files.length,
    );
    for (const component of receipt.conveyance.components) {
      assert.ok(
        component.files.every((file) =>
          component.addresses.some(
            (a) => a.context === file.context && file.path === `${a.path}/${file.archivePath}`,
          ),
        ),
      );
      assert.equal(
        component.files.every((file) =>
          plan.files.some((p) => p.path === file.path && p.sha256 === file.sha256),
        ),
        true,
      );
    }
    assert.ok(
      receipt.conveyance.components.every(
        (item) =>
          !["typescript", "@biomejs/biome", "node-gyp"].some((name) =>
            item.archiveId.startsWith(`${name}@`),
          ),
      ),
    );
    if (name === "fortipi-cli") {
      assert.ok(
        receipt.conveyance.external.some(
          (item) => item.archiveId === "@img/sharp-wasm32@0.35.5" && item.reason === "native",
        ),
      );
      assert.equal(
        receipt.conveyance.components.some((item) => item.archiveId.startsWith("@img/sharp")),
        false,
      );
      const wasm = receipt.conveyance.components.find(
        (item) => item.archiveId === "blake3-wasm@2.1.5",
      );
      assert.equal(wasm?.files.filter((file) => file.archivePath.endsWith(".wasm")).length, 3);
      const miniflare = receipt.conveyance.components.find(
        (item) => item.archiveId === "miniflare@5.20261113.0-beta",
      );
      assert.ok(miniflare);
      const markdown = miniflare.files.filter((file) => file.archivePath.endsWith(".wasm"));
      assert.equal(markdown.length, 1);
      assert.equal(markdown[0]?.archivePath, "dist/src/mdream_edge_bg.wasm");
      assert.equal(markdown[0]?.size, 239214);
      assert.equal(
        markdown[0]?.sha256,
        "db48fb63ec419083fdcd2100171bb5f40c5086164a9fe939286927727c91256b",
      );
      const markdownNotices = receipt.texts.filter(
        (item) => item.archiveId === miniflare.archiveId && item.path.includes("/mdream/2.0.3/"),
      );
      assert.equal(markdownNotices.length, 4);
      const rustNotices = markdownNotices.find((item) => item.path.endsWith("RUST-NOTICES.md"));
      assert.ok(rustNotices);
      assert.match(
        await readFile(resolve(output, rustNotices.path), "utf8"),
        /not asserted to be an exact compiled-code inventory/,
      );
      assert.match(await readFile(resolve(output, rustNotices.path), "utf8"), /UNICODE LICENSE V3/);
      const sdk = receipt.conveyance.components.find(
        (item) => item.archiveId === "@anthropic-ai/sdk@0.129.0",
      );
      assert.ok(sdk);
      const raw = await regularBytes(
        resolve(facts, "dist/supply-chain/archives", `${sha256(sdk.archiveId)}.tgz`),
      );
      const entries = archiveEntries(raw);
      const credentialPaths = [...entries.keys()]
        .filter((path) => /^package\/(?:src\/)?lib\/credentials\//.test(path))
        .map((path) => path.slice(8))
        .sort();
      assert.equal(credentialPaths.length, 54);
      assert.deepEqual(
        receipt.conveyance.permittedBlockedFiles
          .map((file) => sdk.files.find((row) => row.path === file.path)?.archivePath)
          .sort(),
        credentialPaths,
      );
      for (const file of receipt.conveyance.permittedBlockedFiles) {
        const member: RuntimeConveyanceMember | undefined = sdk.files.find(
          (row) => row.path === file.path,
        );
        assert.ok(member);
        assert.equal(
          file.sha256,
          sha256(entries.get(`package/${member.archivePath}`) ?? new Uint8Array()),
        );
      }
      for (const path of ["package/LICENSE", "package/src/internal/qs/LICENSE.md"]) {
        const text: RuntimeNoticeReceipt["texts"][number] | undefined = receipt.texts.find(
          (item) => item.archiveId === sdk.archiveId && item.source === `${sdk.archiveId}/${path}`,
        );
        assert.ok(text);
        assert.deepEqual(await regularBytes(resolve(output, text.path)), entries.get(path));
      }
      const patched = receipt.conveyance.components.find(
        (item) => item.archiveId === "@earendil-works/pi-ai@1.5.2",
      );
      assert.ok(patched?.patch);
      const patch = receipt.texts.find(
        (item) => item.archiveId === patched.archiveId && item.kind === "patch",
      );
      assert.ok(patch);
      assert.equal(patch.sha256, patched.patch.sha256);
      assert.deepEqual(
        await regularBytes(resolve(output, patch.path)),
        await regularBytes(resolve(repository, patched.patch.path)),
      );
      assert.match(
        (await readFile(resolve(output, "THIRD_PARTY_NOTICES.md"))).toString(),
        /source-verified dependency files/,
      );
      assert.ok(
        receipt.conveyance.components.find(
          (item) => item.archiveId === "@aws-sdk/credential-provider-login@3.972.92",
        ),
      );
    }
    if (name === "fortipi-tui") {
      assert.ok(
        receipt.conveyance.external.some(
          (item) => item.archiveId === "@earendil-works/pi-tui@1.5.2",
        ),
      );
      assert.equal(
        receipt.conveyance.components.some(
          (item) => item.archiveId === "@earendil-works/pi-tui@1.5.2",
        ),
        false,
      );
    }
  }
  assert.deepEqual(
    await inventory(resolve(repository, "packages/fortipi-cli/worker-assets/licenses")),
    worker,
  );
  assert.deepEqual(
    await Promise.all(
      packagePaths.map((path) => regularBytes(resolve(repository, path, "THIRD_PARTY_NOTICES.md"))),
    ),
    own,
  );
});

test("the exact reviewed Markdown dependency member rejects archive, path, hash, license and attribution substitutions", async () => {
  const source = closure.archives.find((item) => item.id === "miniflare@5.20261113.0-beta");
  assert.ok(source);
  const member = source.files.find((file) => file.path === "dist/src/mdream_edge_bg.wasm");
  assert.ok(member);
  const policy = (await readJson(resolve(facts, "tools/unstale/license-policy.json"))) as {
    attributions: Record<string, Parameters<typeof assertRuntimeWasmMember>[4]>;
  };
  const attribution = policy.attributions[source.id];
  assertRuntimeWasmMember(source.id, source.archiveSha256, member, "MIT", attribution);
  for (const [id, archive, changed, license, legal] of [
    ["miniflare@5.20261110.2-beta", source.archiveSha256, member, "MIT", attribution],
    [source.id, "f".repeat(64), member, "MIT", attribution],
    [
      source.id,
      source.archiveSha256,
      { ...member, path: "dist/src/another.wasm" },
      "MIT",
      attribution,
    ],
    [source.id, source.archiveSha256, { ...member, sha256: "f".repeat(64) }, "MIT", attribution],
    [source.id, source.archiveSha256, { ...member, size: member.size + 1 }, "MIT", attribution],
    [source.id, source.archiveSha256, member, "Unreviewed license", attribution],
    [source.id, source.archiveSha256, member, "MIT", undefined],
  ] as const)
    assert.throws(() => assertRuntimeWasmMember(id, archive, changed, license, legal));
});

test("the genuine Markdown dependency bytes remain forbidden in owned outputs even with another filename", {
  timeout: 120000,
}, async () => {
  const changed = resolve(root, "owned-wasm-copy");
  await cp(facts, changed, {
    recursive: true,
    force: false,
    errorOnExist: true,
    mode: constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE,
  });
  for (const directory of [
    ...packagePaths.map((path) => `${path}/dist`),
    "apps/worker/dist/worker",
    "packages/fortipi-cli/worker-assets",
  ]) {
    await mkdir(dirname(resolve(changed, directory)), { recursive: true });
    await cp(resolve(repository, directory), resolve(changed, directory), {
      recursive: true,
      force: false,
      errorOnExist: true,
      mode: constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE,
    });
  }
  const id = "miniflare@5.20261113.0-beta";
  const entries = archiveEntries(
    await regularBytes(resolve(facts, `dist/supply-chain/archives/${sha256(id)}.tgz`)),
  );
  const bytes = entries.get("package/dist/src/mdream_edge_bg.wasm");
  assert.ok(bytes);
  await writeFile(
    resolve(changed, "packages/fortipi-cli/worker-assets/unexpected-asset.dat"),
    bytes,
  );
  await assert.rejects(
    checkLicenses(changed),
    /External tool\/native bytes copied into own output/,
  );
});

test("missing original text or altered reviewed patch fails before output; existing legal output is never overwritten", {
  timeout: 120000,
}, async () => {
  const plan = cliPlan();
  for (const fault of ["missing-license", "patch"]) {
    const changed = resolve(root, fault);
    await cp(facts, changed, {
      recursive: true,
      force: false,
      errorOnExist: true,
      mode: constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE,
    });
    if (fault === "missing-license")
      await rm(
        resolve(
          changed,
          "dist/supply-chain/licenses/@anthropic-ai__sdk@0.129.0/package/src/internal/qs/LICENSE.md",
        ),
      );
    else {
      const source = closure.archives.find((item) => item.id === "@earendil-works/pi-ai@1.5.2");
      assert.ok(source?.patch);
      await writeFile(resolve(changed, source.patch.path), "altered public patch\n");
    }
    const output = resolve(root, `${fault}-output`);
    await assert.rejects(generateRuntimeNotices(changed, closure, plan, output));
    await assert.rejects(readJson(resolve(output, "LICENSE")), { code: "ENOENT" });
  }
  const destination = resolve(root, "existing-legal");
  await generateRuntimeNotices(facts, closure, plan, destination);
  const original = await inventory(destination);
  await assert.rejects(generateRuntimeNotices(facts, closure, plan, destination), {
    code: "EEXIST",
  });
  assert.deepEqual(await inventory(destination), original);
});

test("copied source/plan JSON cannot authorize conveyance and changed policy inputs invalidate a real plan", async () => {
  const plan = cliPlan();
  await assert.rejects(
    reviewRuntimeConveyance(facts, JSON.parse(JSON.stringify(closure)), plan),
    /trusted checkout/,
  );
  await assert.rejects(
    reviewRuntimeConveyance(facts, closure, JSON.parse(JSON.stringify(plan))),
    /authenticated source/,
  );
  const changed = resolve(root, "changed-policy");
  await cp(facts, changed, {
    recursive: true,
    force: false,
    errorOnExist: true,
    mode: constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE,
  });
  await writeFile(resolve(changed, "tools/unstale/license-policy.json"), "{}\n");
  await assert.rejects(
    reviewRuntimeConveyance(changed, closure, plan),
    /Stale runtime legal input/,
  );
});
