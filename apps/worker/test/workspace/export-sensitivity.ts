import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { root } from "./harness.ts";

const directory = resolve(root, "apps/worker/src/workspace");
const paths = [
  resolve(directory, ".export-fault.ts"),
  resolve(directory, ".export-workspace-fault.ts"),
  resolve(directory, ".export-authority-fault.ts"),
  resolve(root, "apps/worker/test/workspace/.export-worker-fault.ts"),
];
const source = await readFile(resolve(directory, "export.ts"), "utf8");
const workspace = await readFile(resolve(directory, "workspace-object.ts"), "utf8");
const authority = await readFile(resolve(directory, "authority.ts"), "utf8");
const fixture = await readFile(
  resolve(root, "apps/worker/test/workspace/runtime-worker.ts"),
  "utf8",
);
await mkdir(resolve(root, "apps/worker/dist"), { recursive: true });
try {
  for (const fault of ["scope", "sha", "floor", "physical"] as const) {
    const changed =
      fault === "scope"
        ? source.replace(
            /row\.request\.resources\[key\]\.every\(\(value\) =>\s*permitsResource\(grant\.resources\[key\], value\),?\s*\)/,
            "true",
          )
        : fault === "sha"
          ? source.replace(
              'length === member.entry.size && whole.digest("hex") === member.entry.sha256',
              "length === member.entry.size",
            )
          : fault === "physical"
            ? source.replace("this.owner.state.bytes + growth <=", "0 <=")
            : source;
    const changedAuthority =
      fault === "floor"
        ? authority.replace(
            /ctx\.generation >= \(state\.get<number>\(`floor:credential:\$\{ctx.credentialId\}`\) \?\? 0\)/,
            "true",
          )
        : authority;
    assert.ok(
      changed !== source || changedAuthority !== authority,
      `Fault did not apply: ${fault}`,
    );
    await writeFile(
      paths[0] ?? "",
      changed.replace('from "./authority.js"', 'from "./.export-authority-fault.js"'),
    );
    await writeFile(
      paths[1] ?? "",
      workspace
        .replace('from "./export.js"', 'from "./.export-fault.js"')
        .replace('from "./authority.js"', 'from "./.export-authority-fault.js"'),
    );
    await writeFile(paths[2] ?? "", changedAuthority);
    await writeFile(
      paths[3] ?? "",
      fixture.replace(
        'from "../../src/workspace/workspace-object.js"',
        'from "../../src/workspace/.export-workspace-fault.js"',
      ),
    );
    const child = spawn(
      process.execPath,
      [
        "--test",
        `--test-name-pattern=${fault === "sha" ? "copy rejects actual" : fault === "physical" ? "physical SQLite" : "logical workspace exports"}`,
        resolve(root, "apps/worker/test/workspace/export.test.ts"),
      ],
      {
        cwd: root,
        env: { ...process.env, FORTIPI_TEST_ENTRY: paths[3] },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
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
    await writeFile(resolve(root, `apps/worker/dist/export-fault-${fault}.log`), output);
    assert.notEqual(code, 0, `Actual export oracle missed ${fault}`);
    const oracle = {
      scope: "Unscoped or split grant read retained export bytes",
      sha: "Export accepted corrupt source bytes",
      floor: "Export peer did not stop on revoke",
      physical: "Export ignored its physical object headroom",
    }[fault];
    assert.ok(
      output.includes(oracle),
      `Fault ${fault} failed for another reason: ${output.slice(-3500)}`,
    );
    process.stdout.write(`${fault}: intended actual workerd oracle detected source fault\n`);
  }
} finally {
  for (const path of paths) await unlink(path).catch(() => {});
}
