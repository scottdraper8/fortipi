/** Temporary source diagnostics only; never SDK, deployment or readiness authority. */
import assert from "node:assert/strict";
import { lstatSync } from "node:fs";
import { mkdir, readFile, realpath } from "node:fs/promises";
import { builtinModules, createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { build, type Plugin } from "esbuild";
import { archive, archiveEntries, hash } from "../tools/unstale/review-supply-chain.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = resolve(root, ".agent-docs/tmp/source-pi-open-probe");
const member = "package/dist/harness/pi/index.js";
const memberSha256 = "260e3af51748cb7eade4a6a1546f23d0bf515fda155b5e8029845e82bb85d5e7";
const archiveSha256 = "985a3e04db1c8500b6dbc6c79cbb1aa43579fef2f2ad903bde7cd3bfa764ff7f";
const integrity =
  "sha512-P6z56NXpYRXHuC1qkMakZBGpZo5btD5478X2AiEplPsTb4DPkYnkMfPt6H3Pv6vRR5mVKIgbvFzpdu24x9wiAA==";
const stages = [
  "last-close.enter",
  "last-close.exit",
  "session-store.enter",
  "session-store.exit",
  "factory.enter",
  "factory.exit",
  "root.enter",
  "root.exit",
  "resume.enter",
  "resume.exit",
  "turn.enter",
  "turn.exit",
  "wake.enter",
  "wake.exit",
] as const;
const mains = { agent: "agent-runtime.mjs", integration: "integration-fixture.mjs" } as const;
const enabled = () => process.env.FORTIPI_SOURCE_PI_OPEN_DIAGNOSTICS === "1";

/** Explicit existing caller mains take precedence over this test-only default. */
export function diagnosticPiMain(kind: keyof typeof mains): string | undefined {
  if (!enabled()) return;
  const path = resolve(directory, mains[kind]),
    stat = lstatSync(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), "Prepared Pi diagnostic main required");
  return path;
}

function overlay(source: string): string {
  const begin = "async function _doOpen(onClose) {\n";
  const end = "\n}\n/**\n* pi began closing:";
  assert.equal(source.split(begin).length, 2, "Pi open function differs");
  const start = source.indexOf(begin),
    stop = source.indexOf(end, start) + 2;
  assert.ok(stop > start, "Pi open boundary differs");
  const original = source.slice(start, stop);
  const steps = [
    ["last-close", "\tawait _classPrivateFieldGet2(_lastClose, this);"],
    ["session-store", "\tconst storage = await openPiSessionStore(this.lifecycle.storage);"],
    [
      "factory",
      "\tconst pi = await _classPrivateFieldGet2(_options, this).harness({\n\t\tstorage,\n\t\tcontext: BG,\n\t\tonWake: _classPrivateFieldGet2(_onWake, this)\n\t});",
    ],
    ["root", "\t\tawait pi.root(BG, { agent: this.agentDefaults() });"],
    ["resume", "\t\tpi.resume();"],
    ["turn", "\t\tawait new Promise((resolve) => setTimeout(resolve, 0));"],
    [
      "wake",
      "\t\tawait _assertClassBrand(_PiHarness_brand, this, _wakeFor).call(this, pi.wake());",
    ],
  ] as const;
  let instrumented = original;
  for (const [tag, needle] of steps) {
    assert.equal(original.split(needle).length, 2, "Pi open stage needle differs");
    const indent = /^\t*/.exec(needle)?.[0] ?? "";
    instrumented = instrumented.replace(
      needle,
      `${indent}console.log("FORTIPI_PI_OPEN_STAGE ${tag}.enter");\n${needle}\n${indent}console.log("FORTIPI_PI_OPEN_STAGE ${tag}.exit");`,
    );
  }
  assert.equal(
    instrumented.replace(
      /^\t+console\.log\("FORTIPI_PI_OPEN_STAGE [a-z-]+\.(?:enter|exit)"\);\n/gm,
      "",
    ),
    original,
    "Pi open overlay changed an original statement",
  );
  return source.slice(0, start) + instrumented + source.slice(stop);
}

/** Original archive, policy and installed member must agree before fixed instrumentation. */
export function diagnosticPiPlugins(): Plugin[] {
  if (!enabled()) return [];
  return [
    {
      name: "source-only-authenticated-pi-open-stages",
      async setup(builder) {
        const require = createRequire(resolve(root, "apps/worker/package.json"));
        const path = await realpath(require.resolve("agents/harness/pi"));
        const policy = JSON.parse(
          await readFile(resolve(root, "tools/unstale/supply-chain.json"), "utf8"),
        );
        const fact = policy.packages["agents@0.33.0"];
        assert.equal(fact?.name, "agents");
        assert.equal(fact.version, "0.33.0");
        assert.equal(fact.integrity, integrity);
        assert.equal(fact.archiveSha256, archiveSha256);
        const raw = await archive("agents", "0.33.0", integrity, root);
        assert.equal(hash(raw), archiveSha256, "Pi diagnostic archive differs");
        const original = archiveEntries(raw).get(member);
        assert.ok(
          original && hash(original) === memberSha256,
          "Pi diagnostic archive member differs",
        );
        const filter = new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
        let transformed = 0;
        builder.onLoad({ filter }, async (args) => {
          const installed = await readFile(args.path);
          assert.deepEqual(
            installed,
            original,
            "Installed Pi open member differs from authenticated archive",
          );
          transformed++;
          return {
            contents: overlay(installed.toString("utf8")),
            loader: "js",
            resolveDir: dirname(path),
          };
        });
        builder.onEnd(() => {
          assert.equal(transformed, 1, "Expected exactly one authenticated Pi open module");
        });
      },
    },
  ];
}

/** Only complete exact marker lines survive; raw runtime output is never emitted or kept as logs. */
export function observePiOpenStages(
  stream: Readable,
  invocation: number,
  emit: (line: string) => void = (line) => console.log(line),
): void {
  if (!enabled() || !Number.isInteger(invocation) || invocation < 1 || invocation > 999) return;
  const decoder = new StringDecoder("utf8");
  let partial = "",
    dropping = false,
    records = 0;
  const flush = () => {
    const line = partial.endsWith("\r") ? partial.slice(0, -1) : partial;
    if (!dropping && records < 1024) {
      const stage = stages.find((tag) => line === `FORTIPI_PI_OPEN_STAGE ${tag}`);
      if (stage) {
        records++;
        try {
          emit(JSON.stringify({ diagnostic: "source-pi-open-stage", invocation, stage }));
        } catch {
          /* Diagnostic delivery cannot change the child result. */
        }
      }
    }
    partial = "";
    dropping = false;
  };
  const accept = (text: string) => {
    for (const character of text) {
      if (character === "\n") flush();
      else if (!dropping) {
        if (partial.length + character.length > 128) {
          partial = "";
          dropping = true;
        } else partial += character;
      }
    }
  };
  stream.on("data", (chunk: Buffer | string) =>
    accept(typeof chunk === "string" ? chunk : decoder.write(chunk)),
  );
  stream.once("end", () => {
    accept(decoder.end());
    flush();
  });
}

async function prepare(): Promise<void> {
  assert.ok(enabled(), "Explicit Pi open diagnostic flag required");
  assert.deepEqual(process.argv.slice(2), ["prepare"]);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const [kind, entry] of [
    ["agent", "apps/worker/test/agent/runtime-worker.ts"],
    ["integration", "apps/worker/test/integration/fixture-worker.ts"],
  ] as const) {
    await build({
      entryPoints: [resolve(root, entry)],
      outfile: resolve(directory, mains[kind]),
      bundle: true,
      format: "esm",
      platform: "neutral",
      target: "es2024",
      mainFields: ["browser", "module", "main"],
      conditions: ["workerd", "worker", "browser"],
      external: ["cloudflare:*", "node:*", ...builtinModules],
      loader: { ".yaml": "json" },
      logLevel: "silent",
      plugins: diagnosticPiPlugins(),
    });
  }
  console.log(JSON.stringify({ diagnostic: "source-pi-open-prepared", files: 2, memberSha256 }));
}
if (import.meta.main) {
  try {
    await prepare();
  } catch {
    console.error('{"diagnostic":"source-pi-open-prepare-failed"}');
    process.exitCode = 1;
  }
}
