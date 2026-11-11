import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";

const directory = await mkdtemp(join(tmpdir(), "fortipi-auth-fault-"));
try {
  for (const fault of [
    "provider-only",
    "latest-only",
    "stale-installed-auth",
    "historical-auth",
  ] as const) {
    const outfile = join(directory, `${fault}.js`);
    let changes = 0;
    await build({
      entryPoints: [resolve("apps/worker/test/models/agent-auth-worker.ts")],
      outfile,
      bundle: true,
      format: "esm",
      platform: "neutral",
      mainFields: ["browser", "module", "main"],
      target: "es2024",
      conditions: ["workerd", "worker", "browser"],
      external: ["cloudflare:*", "node:*", ...builtinModules],
      loader: { ".yaml": "json" },
      logLevel: "silent",
      plugins: [
        {
          name: "owned-model-regression",
          setup(builder) {
            builder.onLoad(
              { filter: /src\/(agent\/agent-session|models\/retained)\.ts$/ },
              async (args) => {
                if (args.path.endsWith("retained.ts") !== (fault === "historical-auth")) return;
                let contents = await readFile(args.path, "utf8");
                const mutations = {
                  "provider-only": [
                    "this.#modelRegistry = installed.models;",
                    "this.#modelRegistry.setProvider(installed.models.getProvider(selected.providerId));",
                  ],
                  "latest-only": [
                    "const { configurations, selected } = await retainedModelConfigurations(this.store);",
                    'const selected = await this.store.get("meta", "selected-model"); const configurations = selected ? [selected] : [];',
                  ],
                  "stale-installed-auth": [
                    "!same(this.#installedModelConfiguration ?? null, selected) ||",
                    "",
                  ],
                  "historical-auth": [
                    "const configurations = [...catalog.values()];",
                    'const configurations = [...catalog.values()]; for (const config of (await store.get<D.ModelConfig[]>("meta", "model-catalog", tx)) ?? []) { if (!catalog.has(config.providerId)) { catalog.set(config.providerId, config); configurations.push(config); } }',
                  ],
                };
                const [needle, replacement] = mutations[fault];
                assert.ok(needle !== undefined && replacement !== undefined);
                assert.equal(contents.split(needle).length, 2);
                contents = contents.replace(needle, replacement);
                changes++;
                return { contents, loader: "ts" };
              },
            );
          },
        },
      ],
    });
    assert.equal(changes, 1);
    const args = [
      "--test",
      `--test-name-pattern=${fault === "provider-only" ? "first real" : fault === "latest-only" ? "cross-provider" : fault === "stale-installed-auth" ? "postcommit" : "finished historical"}`,
      fault === "provider-only" || fault === "latest-only"
        ? "apps/worker/test/models/agent-auth.test.ts"
        : "apps/worker/test/models/registry-recovery.test.ts",
    ];
    let code = 0,
      output = "";
    try {
      const result = await promisify(execFile)(process.execPath, args, {
        env: { ...process.env, FORTIPI_T5_AUTH_WORKER: outfile },
        timeout: 55000,
        maxBuffer: 128000,
      });
      output = result.stdout;
    } catch (error) {
      const failed = error as { code?: number; stdout?: string; stderr?: string; killed?: boolean };
      assert.equal(failed.killed, false, "A timeout is not sensitivity evidence");
      code = failed.code ?? -1;
      output = (failed.stdout ?? "") + (failed.stderr ?? "");
    }
    assert.equal(code, 1, `${fault}: actual behavioral oracle must fail`);
    assert.ok(
      output.includes(
        fault === "provider-only"
          ? '"reachedProvider":false,"correctBoundCredential":false'
          : fault === "latest-only"
            ? '"canarySurvived":true,"oldProviderReached":false,"oldCredentialCorrect":false'
            : fault === "stale-installed-auth"
              ? '"selectionCommitted":true,"finalAuthorityRejected":true,"oauthUsed":false,"staleApiKeyReused":true'
              : '"currentProviderReady":false,"missingBoundCredential":true',
      ),
      output,
    );
    assert.ok(
      output.includes("AssertionError"),
      "Each fault must reach its named behavioral assertion",
    );
    console.log(JSON.stringify({ fault, actualBehavioralFailure: true }));
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
