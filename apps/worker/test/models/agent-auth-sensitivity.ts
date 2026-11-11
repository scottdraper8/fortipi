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
  for (const fault of ["provider-only", "latest-only"] as const) {
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
            builder.onLoad({ filter: /src\/agent\/agent-session\.ts$/ }, async (args) => {
              let contents = await readFile(args.path, "utf8");
              const needle =
                fault === "provider-only"
                  ? "this.#modelRegistry = installed.models;"
                  : "const { configurations } = await retainedModelConfigurations(this.store);";
              assert.equal(contents.split(needle).length, 2);
              contents = contents.replace(
                needle,
                fault === "provider-only"
                  ? "this.#modelRegistry.setProvider(installed.models.getProvider(selected.providerId));"
                  : 'const selected = await this.store.get("meta", "selected-model"); const configurations = selected ? [selected] : [];',
              );
              changes++;
              return { contents, loader: "ts" };
            });
          },
        },
      ],
    });
    assert.equal(changes, 1);
    const args = [
      "--test",
      `--test-name-pattern=${fault === "provider-only" ? "first real" : "cross-provider"}`,
      "apps/worker/test/models/agent-auth.test.ts",
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
          : '"canarySurvived":true,"oldProviderReached":false,"oldCredentialCorrect":false',
      ),
      output,
    );
    assert.ok(
      output.includes("AssertionError"),
      "Compiler/startup failures are not sensitivity evidence",
    );
    console.log(JSON.stringify({ fault, actualBehavioralFailure: true }));
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
