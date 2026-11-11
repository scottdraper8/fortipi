import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applicationCredential, loadProfiles, saveProfiles } from "fortipi-tui";
import { protectDirectory, writeProtected } from "../dist/credentials.js";

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
