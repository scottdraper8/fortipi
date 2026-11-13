import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { freeInfrastructurePolicy } from "fortipi-contract";
import { adapter, privateRead, privateWrite } from "../dist/config.js";
import { childEnvironment } from "../dist/platform/types.js";
import { configureProfile } from "../dist/provision.js";
import { fixture } from "./fixtures/daemon.ts";

test("configure uses anonymous bounded discovery, exclusive protected output and explicit repository bindings without enabling the host", async () => {
  const f = await fixture(),
    platform = adapter();
  const observed: { path: string; authorization: string | undefined }[] = [];
  let feature = true,
    redirect = false;
  const server = createServer((req, res) => {
    observed.push({ path: req.url ?? "", authorization: req.headers.authorization });
    if (redirect) {
      res.writeHead(302, { Location: "http://127.0.0.1:1/elsewhere" });
      res.end();
      return;
    }
    res.end(
      JSON.stringify({
        protocolVersion: "1.0",
        schemaVersion: "1.0.0",
        deploymentId: f.profile.deploymentId,
        features: feature ? ["executor-ledger-instance-v1"] : [],
        infrastructure: freeInfrastructurePolicy,
        limits: { jsonBytes: 1048576, chunkBytes: 262144, outputFrameBytes: 16384 },
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await mkdir(join(f.rootPath, ".git")); // A user's ordinary repository IS an eligible workspace.
    const envelope = {
      version: 1,
      endpoint: origin,
      role: "executor",
      credential: f.profile.credential,
      token: f.profile.token,
      expiresAt: Date.now() + 60000,
    };
    const device = {
      expectedDeploymentId: f.profile.deploymentId,
      executorId: f.profile.executorId,
      executorGeneration: f.profile.executorGeneration,
      resources: f.profile.resources,
      bindings: f.profile.bindings,
      limits: { fileBytes: 1024 },
    };
    const credential = join(f.path, "issued.json"),
      input = join(f.path, "device.json"),
      output = join(f.path, "new.json");
    await privateWrite(credential, JSON.stringify(envelope));
    await privateWrite(input, JSON.stringify(device));
    const binary = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
    const result = await promisify(execFile)(
      process.execPath,
      [
        binary,
        "configure",
        "--credential-file",
        credential,
        "--input",
        input,
        "--profile",
        output,
        "--local-test",
      ],
      { env: childEnvironment(), timeout: 10000 },
    );
    const configured = JSON.parse(await privateRead(output));
    assert.equal(configured.origin, origin);
    assert.equal(configured.credentialExpiresAt, envelope.expiresAt);
    assert.equal(configured.limits.fileBytes, 1024);
    assert.deepEqual(configured.policy, {
      version: 1,
      trustedHost: false,
      requireConfinement: false,
      rules: [],
    });
    assert.deepEqual(configured.bindings, f.profile.bindings);
    assert.equal(configured.ledgerInstanceId, undefined);
    assert.notEqual(configured.ledgerId, f.profile.ledgerId);
    assert.deepEqual(JSON.parse(result.stdout), {
      version: 1,
      executorId: f.profile.executorId,
      executorGeneration: f.profile.executorGeneration,
      ledgerId: configured.ledgerId,
      hostConsent: false,
      ledgerProvisioned: false,
    });
    assert.equal(result.stderr.includes(envelope.token), false);
    assert.equal(result.stdout.includes(envelope.token), false);
    assert.equal(await readFile(credential, "utf8"), JSON.stringify(envelope));
    const original = await privateRead(output);
    await assert.rejects(configureProfile(credential, input, output, platform, true), {
      code: "EEXIST",
    });
    assert.equal(await privateRead(output), original);
    for (const changed of [
      { ...envelope, role: "client" },
      { ...envelope, state: "pending" },
      { ...envelope, expiresAt: 1 },
      { ...envelope, endpoint: `${origin}/override` },
    ]) {
      await privateWrite(credential, JSON.stringify(changed));
      await assert.rejects(
        configureProfile(credential, input, join(f.path, "refused.json"), platform, true),
      );
    }
    const privateCanary = "synthetic-malformed-secret-CANARY-4837";
    await privateWrite(credential, `{"token":"${privateCanary}",invalid:${privateCanary}`);
    await assert.rejects(
      promisify(execFile)(
        process.execPath,
        [
          binary,
          "configure",
          "--credential-file",
          credential,
          "--input",
          input,
          "--profile",
          join(f.path, "refused.json"),
          "--local-test",
        ],
        { env: childEnvironment(), timeout: 10000 },
      ),
      (error: unknown) => {
        const failure = error as Error & { code: number; stdout: string; stderr: string };
        assert.equal(failure.code, 1);
        assert.equal(failure.stdout, "");
        assert.equal(failure.stderr.trim(), "invalid or unsafe protected issued executor envelope");
        assert.equal(failure.stderr.includes(privateCanary), false);
        assert.equal(failure.stderr.includes(envelope.token), false);
        return true;
      },
    );
    await privateWrite(credential, JSON.stringify(envelope));
    for (const changed of [
      { ...device, origin },
      { ...device, executorGeneration: 0 },
      { ...device, expectedDeploymentId: "foreign" },
      { ...device, limits: { unexpected: 1 } },
      { ...device, bindings: [{ ...f.profile.bindings[0], path: f.path }] },
    ]) {
      await privateWrite(input, JSON.stringify(changed));
      await assert.rejects(
        configureProfile(credential, input, join(f.path, "refused.json"), platform, true),
      );
    }
    await privateWrite(input, JSON.stringify(device));
    feature = false;
    await assert.rejects(
      configureProfile(credential, input, join(f.path, "refused.json"), platform, true),
      /incompatible/,
    );
    feature = true;
    redirect = true;
    await assert.rejects(
      configureProfile(credential, input, join(f.path, "refused.json"), platform, true),
    );
    assert.ok(observed.length > 0);
    assert.ok(observed.every((r) => r.path === "/v1/protocol" && r.authorization === undefined));
    await assert.rejects(readFile(join(f.path, "refused.json")), { code: "ENOENT" });
    assert.equal(await privateRead(output), original);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
    await f.cleanup();
  }
});
