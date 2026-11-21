import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { root } from "../workspace/harness.ts";

const sourcePath = resolve(root, "apps/worker/src/container/.quiescence-host-transport.ts");
const entry = resolve(root, "apps/worker/test/backends/.quiescence-worker.ts");
const config = resolve(root, "apps/worker/dist/tsconfig.quiescence-fault.json");
const source = await readFile(resolve(root, "apps/worker/src/container/host-transport.ts"), "utf8");
const fixture = await readFile(
  resolve(root, "apps/worker/test/backends/host-rpc-worker.ts"),
  "utf8",
);
async function run(args: string[], faulty = false) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: {
      ...process.env,
      ...(faulty
        ? { FORTIPI_QUIESCE_TEST_ENTRY: entry, FORTIPI_HOST_STORAGE_TEST_ENTRY: entry }
        : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (bytes: Buffer) => {
    output += bytes.toString();
  });
  child.stderr.on("data", (bytes: Buffer) => {
    output += bytes.toString();
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
  return { code, output };
}
await mkdir(resolve(root, "apps/worker/dist"), { recursive: true });
try {
  await writeFile(
    entry,
    fixture.replace(
      '"../../src/container/host-transport.js"',
      '"../../src/container/.quiescence-host-transport.js"',
    ),
  );
  await writeFile(
    config,
    JSON.stringify({ extends: "../tsconfig.json", include: [], files: [entry] }),
  );
  const hostStorage = process.argv.includes("--host-storage");
  const faults = hostStorage
    ? (["assertion-strip", "prepared-image", "physical-bytes"] as const)
    : (["intent", "ownership", "observation", "tombstone"] as const);
  for (const fault of faults) {
    const changed =
      fault === "assertion-strip"
        ? source.replace(
            "delete env[runtimeHostContextEnv];",
            "// Private assertion leaked into delegate",
          )
        : fault === "prepared-image"
          ? source.replace("image.endsWith(`@${context.imageDigest}`)", "true")
          : fault === "physical-bytes"
            ? source.replace("bytes: this.storage.sql.databaseSize,", "bytes: 0,")
            : fault === "intent"
              ? source.replace(
                  "await this.storage.put(stopKey, stop);",
                  "// Missing pre-effect durable intent",
                )
              : fault === "ownership"
                ? source.replace(
                    "before.labels[ownershipLabel] === current.ownershipDigest",
                    "true",
                  )
                : fault === "observation"
                  ? source.replace("after === null && !stopped.running", "true")
                  : source.replaceAll("!(await this.storage.get(stopKey))", "true");
    assert.notEqual(changed, source, `Fault did not apply: ${fault}`);
    await writeFile(sourcePath, changed);
    const compiled = await run([resolve(root, "node_modules/typescript/bin/tsc"), "-p", config]);
    assert.equal(
      compiled.code,
      0,
      `Fault did not compile under unchanged strict Worker settings: ${compiled.output}`,
    );
    const pattern =
      fault === "physical-bytes"
        ? "Host physical samples"
        : hostStorage
          ? "Host context blocks"
          : fault === "ownership" || fault === "observation"
            ? "private stop rejects"
            : "production private host";
    const result = await run(
      [
        "--test",
        `--test-name-pattern=${pattern}`,
        resolve(
          root,
          `apps/worker/test/backends/${hostStorage ? "host-storage" : "quiescence"}.test.ts`,
        ),
      ],
      true,
    );
    assert.notEqual(result.code, 0, `Native quiescence fault escaped actual DO oracle: ${fault}`);
    assert.match(
      result.output,
      /AssertionError/,
      `Fault failed outside behavioral assertions: ${result.output}`,
    );
    console.log(`Actual controlled host quiescence rejected ${fault}`);
  }
} finally {
  await Promise.all([sourcePath, entry, config].map((path) => unlink(path).catch(() => {})));
}
