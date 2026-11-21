import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { applicationCredential, loadProfiles, saveProfiles } from "fortipi-tui";
import { protectDirectory, writeProtected } from "../dist/credentials.js";

void test("the actual TUI bin selects a private profiles file with default-home access denied", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fortipi-profile-bin-"));
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const bin = resolve(root, "packages/fortipi-tui/dist/bin.js");
  try {
    await protectDirectory(directory);
    const path = join(directory, "profiles.json");
    await saveProfiles(
      {
        version: 1,
        profiles: [
          {
            name: "private",
            endpoint: "https://example.test",
            credentialFile: join(directory, "unused-client.json"),
          },
        ],
      },
      path,
    );
    const run = async (args: string[]) =>
      promisify(execFile)(
        process.execPath,
        [
          "--permission",
          `--allow-fs-read=${root}`,
          `--allow-fs-read=${directory}`,
          // Existing Windows ACL checks invoke a fixed PowerShell -NoProfile helper.
          ...(process.platform === "win32" ? ["--allow-child-process"] : []),
          bin,
          ...args,
        ],
        {
          cwd: directory,
          env: {
            PATH: process.env.PATH,
            ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
          },
          timeout: 15000,
          maxBuffer: 65536,
        },
      ).then(
        () => assert.fail("Noninteractive TUI unexpectedly succeeded"),
        (error: { code: number; stderr: string }) => {
          assert.equal(error.code, 1);
          return error.stderr;
        },
      );
    // The normal path is outside the explicit filesystem grants; it cannot read user profiles.
    assert.match(await run([]), /invalid_profiles/);
    assert.match(
      await run(["--profiles-file", path, "--profile", "private"]),
      /interactive_terminal_required/,
    );
    for (const args of [
      ["--profiles-file"],
      ["--profiles-file", "relative.json"],
      ["--profiles-file", path, "--profiles-file", path],
    ])
      assert.match(await run(args), /invalid_arguments/);
    if (process.platform !== "win32") {
      await chmod(path, 0o644);
      assert.match(await run(["--profiles-file", path]), /invalid_profiles/);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("profiles and credentials use protected real files, bind origin and reject role, permissions and symlink aliases", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fortipi-profile-"));
  try {
    await protectDirectory(directory);
    const path = join(directory, "profiles.json"),
      credential = join(directory, "application.json");
    const profiles = {
      version: 1 as const,
      profiles: [{ name: "local", endpoint: "https://example.test", credentialFile: credential }],
    };
    await saveProfiles(profiles, path);
    assert.deepEqual(await loadProfiles(path), profiles);
    await writeProtected(
      credential,
      JSON.stringify({
        version: 1,
        endpoint: "https://example.test",
        role: "client",
        token: "synthetic-application",
      }),
    );
    assert.equal(
      await applicationCredential(credential, "https://example.test"),
      "synthetic-application",
    );
    await assert.rejects(applicationCredential(credential, "https://foreign.test"));
    const operator = join(directory, "operator.json");
    await writeProtected(
      operator,
      JSON.stringify({
        version: 1,
        endpoint: "https://example.test",
        role: "admin",
        token: "synthetic-operator",
      }),
    );
    await assert.rejects(applicationCredential(operator, "https://example.test"));
    if (process.platform !== "win32") {
      await chmod(credential, 0o644);
      await assert.rejects(applicationCredential(credential, "https://example.test"));
      await chmod(credential, 0o600);
      const alias = join(directory, "alias.json");
      await symlink(credential, alias);
      await assert.rejects(applicationCredential(alias, "https://example.test"));
    }
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        profiles: [{ name: "bad", endpoint: "https://example.test", credentialFile: "relative" }],
      }),
    );
    await assert.rejects(loadProfiles(path), { code: "invalid_profiles" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
