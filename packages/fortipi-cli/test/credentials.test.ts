import assert from "node:assert/strict";
import { chmod, link, lstat, mkdir, readFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { issueCredential } from "../dist/credentials.js";
import { loadProfile, readProtected, replaceProtected, writeProtected } from "../dist/profiles.js";
import { ensureModelAuthKey, localBootstrap } from "../dist/setup.js";
import type { WranglerPort, WranglerRequest } from "../dist/wrangler.js";
import { json, server, temp } from "./fixtures.ts";

test("real filesystem protection rejects permissive modes, symlinks, hardlinks and overwrite before issuance", async (t) => {
  const root = await temp(t);
  const path = join(root, "profile.json");
  const value = {
    version: 1,
    endpoint: "https://example.com",
    role: "admin",
    token: "synthetic-canary",
  };
  await writeProtected(path, value);
  assert.equal((await lstat(path)).mode & 0o777, 0o600);
  assert.equal((await loadProfile(path)).endpoint, value.endpoint);
  await assert.rejects(writeProtected(path, value), /protected_destination_unavailable/);
  await chmod(path, 0o644);
  await assert.rejects(readProtected(path), /protected_permissions_required/);
  await chmod(path, 0o600);
  await symlink(path, join(root, "linked.json"));
  await assert.rejects(readProtected(join(root, "linked.json")), /unsafe_protected_path/);
  await link(path, join(root, "hard.json"));
  await assert.rejects(readProtected(path), /unsafe_protected_path/);
  const directory = join(root, "real");
  await mkdir(directory, { mode: 0o700 });
  await symlink(directory, join(root, "dir-link"));
  await assert.rejects(
    writeProtected(join(root, "dir-link", "secret.json"), value),
    /unsafe_parent/,
  );
  let requests = 0;
  const { api } = await server(t, (_req, res) => {
    requests++;
    json(res, {});
  });
  await assert.rejects(
    issueCredential(api, value.endpoint, path, {
      requestId: "request-A",
      role: "client",
      grants: [],
    }),
    /protected_destination_unavailable/,
  );
  assert.equal(requests, 0);
});

test("one-time delivery is direct to protected exact-origin profile; lost response retains recovery identity without retry", async (t) => {
  const root = await temp(t);
  let requests = 0;
  let shouldLose = false;
  const { api, endpoint } = await server(t, (req, res) => {
    requests++;
    if (shouldLose) {
      req.destroy();
      return;
    }
    json(
      res,
      {
        credential: { credentialId: "credential-A", generation: 0, grantVersion: 0 },
        token: "synthetic-issued-canary",
        role: "client",
        state: "issued",
      },
      201,
    );
  });
  const path = join(root, "client.json");
  const receipt = await issueCredential(api, endpoint, path, {
    requestId: "request-A",
    role: "client",
    grants: [],
  });
  assert.equal(JSON.stringify(receipt).includes("synthetic-issued-canary"), false);
  assert.equal((await loadProfile(path, true)).token, "synthetic-issued-canary");
  assert.equal((await lstat(path)).mode & 0o777, 0o600);
  shouldLose = true;
  const lost = join(root, "lost.json");
  await assert.rejects(
    issueCredential(api, endpoint, lost, { requestId: "request-B", role: "client", grants: [] }),
    /mutation_uncertain_query_receipt/,
  );
  assert.deepEqual(await readProtected(lost), {
    version: 1,
    endpoint,
    state: "pending",
    requestId: "request-B",
  });
  assert.equal(requests, 2);
});

test("bootstrap reuse and key retry preserve durable synthetic identity; unknown existing server key is untouched", async (t) => {
  const root = await temp(t);
  const install = join(root, "installation");
  const first = await localBootstrap(install, "https://example.com");
  assert.equal(first.token.length, 64);
  assert.deepEqual(await localBootstrap(install, first.endpoint), first);
  await assert.rejects(
    localBootstrap(install, "https://other.example"),
    /bootstrap_identity_mismatch/,
  );
  const calls: WranglerRequest[] = [];
  let existing = true;
  let failUpload = true;
  const port: WranglerPort = {
    async run(request) {
      calls.push(request);
      if (request.args[1] === "list")
        return JSON.stringify(
          existing ? [{ name: "FORTIPI_MODEL_AUTH_KEY", type: "secret_text" }] : [],
        );
      if (failUpload) throw new Error("synthetic interrupted stdin");
      return "";
    },
  };
  const noLocalKey = join(root, "remote-only");
  await ensureModelAuthKey(port, root, noLocalKey, first.endpoint);
  await assert.rejects(lstat(noLocalKey), { code: "ENOENT" });
  assert.equal(calls.length, 1);
  existing = false;
  await assert.rejects(
    ensureModelAuthKey(port, root, install, first.endpoint),
    /interrupted stdin/,
  );
  const saved = await readProtected(join(install, "model-auth-key.json"));
  failUpload = false;
  await ensureModelAuthKey(port, root, install, first.endpoint);
  assert.deepEqual(await readProtected(join(install, "model-auth-key.json")), saved);
  const puts = calls.filter((c) => c.args[1] === "put");
  assert.equal(puts[0]?.input, puts[1]?.input);
  assert.equal(
    puts[1]?.args.some((a) => a === puts[1]?.input),
    false,
  );
  await replaceProtected(join(install, "model-auth-key.json"), {
    endpoint: first.endpoint,
    key: "synthetic-invalid-key",
  });
  await assert.rejects(
    ensureModelAuthKey(port, root, install, first.endpoint),
    /model_auth_key_repair_required/,
  );
  assert.equal(
    (await readFile(join(install, "bootstrap.json"), "utf8")).includes(first.token),
    true,
  );
});

test("a destination that loses protection after issuance leaves only recovery metadata and never remints", async (t) => {
  const root = await temp(t);
  const path = join(root, "delivery.json");
  let requests = 0;
  const { api, endpoint } = await server(t, (_req, res) => {
    requests++;
    void chmod(path, 0o644).then(() =>
      json(
        res,
        {
          credential: { credentialId: "credential-B", generation: 0, grantVersion: 0 },
          token: "synthetic-never-delivered",
          role: "client",
          state: "issued",
        },
        201,
      ),
    );
  });
  await assert.rejects(
    issueCredential(api, endpoint, path, { requestId: "request-F", role: "client", grants: [] }),
    /credential_delivery_failed_revoke_or_replace/,
  );
  const saved = await readFile(path, "utf8");
  assert.equal(saved.includes("synthetic-never-delivered"), false);
  const metadata = JSON.parse(saved) as { state: string; credential: { credentialId: string } };
  assert.equal(metadata.state, "delivery-failed");
  assert.equal(metadata.credential.credentialId, "credential-B");
  assert.equal(requests, 1);
});
