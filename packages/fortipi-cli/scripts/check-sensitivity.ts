import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

// Disposable compiled copies only. This is sensitivity evidence, never installed-distribution proof.
const source = fileURLToPath(new URL("../", import.meta.url));
const root = await mkdtemp(join(await realpath(tmpdir()), "fortipi-cli-faults-"));
const execute = promisify(execFile);
async function run(
  testFile: string,
  name: string,
  pass: boolean,
  expectedFailure = "",
): Promise<void> {
  try {
    await execute(process.execPath, ["--test", `--test-name-pattern=${name}`, `test/${testFile}`], {
      cwd: root,
      timeout: 30000,
      maxBuffer: 65536,
    });
    assert.ok(pass, "Fault was not detected");
  } catch (e) {
    if (pass) throw e;
    const output = (e as { stdout?: string }).stdout ?? "";
    assert.ok(output.includes(expectedFailure), "Fault failed for an unexpected reason");
  }
}
try {
  for (const path of ["dist", "test", "templates", "package.json"])
    await cp(join(source, path), join(root, path), { recursive: true });
  await symlink(
    join(source, "node_modules"),
    join(root, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const permissionPath = join(root, "dist/profiles.js");
  const original = await readFile(permissionPath, "utf8");
  const mutant = original
    .replace("(stat.mode & 0o777) === (directory ? 0o700 : 0o600)", "true")
    .replace("(held.mode & 0o777) === 0o600", "true");
  assert.notEqual(mutant, original);
  await writeFile(permissionPath, mutant);
  await run(
    "credentials.test.ts",
    "real filesystem protection",
    false,
    "Missing expected rejection",
  );
  await writeFile(permissionPath, original);
  await run("credentials.test.ts", "real filesystem protection", true);
  const leakedEnvironment = original.replace('"TERM"', '"TERM", "GITHUB_TOKEN"');
  assert.notEqual(leakedEnvironment, original);
  await writeFile(permissionPath, leakedEnvironment);
  await run("commands.test.ts", "actual pinned Wrangler", false, "GITHUB_TOKEN");
  await writeFile(permissionPath, original);
  await run("commands.test.ts", "actual pinned Wrangler", true);
  const oauthPath = join(root, "dist/model-auth.js");
  const oauth = await readFile(oauthPath, "utf8");
  const missingExtension = oauth.replace(
    "...(Object.keys(fields).length ? { providerFields: fields } : {}),",
    "",
  );
  assert.notEqual(oauth, missingExtension);
  await writeFile(oauthPath, missingExtension);
  await run(
    "model-auth.test.ts",
    "actual public Pi OpenAI",
    false,
    "Expected values to be strictly deep-equal",
  );
  await writeFile(oauthPath, oauth);
  await run("model-auth.test.ts", "actual public Pi OpenAI", true);
  const helperPath = join(root, "dist/windows-helper.js");
  const helper = await readFile(helperPath, "utf8");
  const relativeHelper = helper.replace(
    'executable: win32.join(psHome, "powershell.exe")',
    'executable: "powershell.exe"',
  );
  assert.notEqual(relativeHelper, helper);
  await writeFile(helperPath, relativeHelper);
  await run(
    "windows-helper.test.ts",
    "Windows ACL helper",
    false,
    "Expected values to be strictly equal",
  );
  await writeFile(helperPath, helper);
  await run("windows-helper.test.ts", "Windows ACL helper", true);
  const adminPath = join(root, "dist/admin.js");
  const admin = await readFile(adminPath, "utf8");
  const remoteText = admin.replace(
    "resource: p.resource,",
    "resource: p.resource, reason: p.reason,",
  );
  assert.notEqual(remoteText, admin);
  await writeFile(adminPath, remoteText);
  await run(
    "commands.test.ts",
    "validated infrastructure errors",
    false,
    "Expected values to be strictly deep-equal",
  );
  await writeFile(adminPath, admin);
  await run("commands.test.ts", "validated infrastructure errors", true);
  // Genuine emitted assets only: corrupt a disposable copy without changing its
  // manifest, require the byte oracle to reject it, then restore and reverify.
  await cp(join(source, "worker-assets"), join(root, "worker-assets"), { recursive: true });
  const assetManifest = JSON.parse(
    await readFile(join(root, "worker-assets/asset-manifest.json"), "utf8"),
  ) as { entry: string };
  const assetEntry = join(root, "worker-assets", assetManifest.entry);
  const originalAsset = await readFile(assetEntry);
  await writeFile(
    assetEntry,
    Buffer.concat([originalAsset, Buffer.from("\n// deliberate asset fault\n")]),
  );
  const verify = async (reject: boolean) =>
    execute(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import assert from 'node:assert/strict';import {verifyAssets} from ${JSON.stringify(pathToFileURL(join(root, "dist/assets.js")).href)};
     ${reject ? "await assert.rejects(verifyAssets(),/asset_integrity_failed/);" : "await verifyAssets();"}`,
      ],
      { cwd: root, timeout: 30000, maxBuffer: 65536 },
    );
  await verify(true);
  await writeFile(assetEntry, originalAsset);
  await verify(false);
  console.log(
    "Permission bypass, role-environment leak, lost OAuth extensions, relative Windows helper, remote pressure text and genuine Worker-byte corruption detected; restored copies pass. This is source/asset sensitivity, not isolated offline Wrangler proof.",
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
