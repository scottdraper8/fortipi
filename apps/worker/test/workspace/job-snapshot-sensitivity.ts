import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { root } from "./harness.ts";

const directory = resolve(root, "apps/worker/src/workspace");
const paths = [
  resolve(directory, ".job-snapshot-fault.ts"),
  resolve(directory, ".job-snapshot-workspace.ts"),
  resolve(root, "apps/worker/test/workspace/.job-snapshot-worker.ts"),
];
const source = await readFile(resolve(directory, "job-snapshot.ts"), "utf8");
const workspace = await readFile(resolve(directory, "workspace-object.ts"), "utf8");
const fixture = await readFile(
  resolve(root, "apps/worker/test/workspace/runtime-worker.ts"),
  "utf8",
);
await mkdir(resolve(root, "apps/worker/dist"), { recursive: true });
try {
  for (const fault of ["full-grant", "after-read", "member"] as const) {
    let changed = source;
    if (fault === "full-grant")
      changed = changed.replace("permitsResource(grant.resources.tools, assignment.tool)", "true");
    if (fault === "member")
      changed = changed.replace(
        'entry.type === "file" && entry.sha256 === sha256',
        'entry.type === "file" && (entry.sha256 === sha256 || !revision.manifest.entries.some((member) => member.type === "file" && member.sha256 === sha256))',
      );
    if (fault === "after-read") {
      const start = source.indexOf("const next = await reader.read();");
      const end = source.indexOf("if (next.done)", start);
      assert.ok(start > 0 && end > start);
      changed =
        source.slice(0, start) +
        source.slice(start, end).replace("proof(owner, ctx, body);", "") +
        source.slice(end);
    }
    assert.notEqual(changed, source, `Fault ${fault} did not apply`);
    await writeFile(paths[0] ?? "", changed);
    await writeFile(
      paths[1] ?? "",
      workspace.replace('from "./job-snapshot.js"', 'from "./.job-snapshot-fault.js"'),
    );
    await writeFile(
      paths[2] ?? "",
      fixture
        .replace(
          'from "../../src/workspace/job-snapshot.js"',
          'from "../../src/workspace/.job-snapshot-fault.js"',
        )
        .replace(
          'from "../../src/workspace/workspace-object.js"',
          'from "../../src/workspace/.job-snapshot-workspace.js"',
        ),
    );
    const child = spawn(
      process.execPath,
      [
        "--test",
        `--test-name-pattern=${fault === "after-read" ? "snapshot streams" : "private native job snapshot"}`,
        resolve(root, "apps/worker/test/workspace/job-snapshot.test.ts"),
      ],
      {
        cwd: root,
        env: { ...process.env, FORTIPI_TEST_ENTRY: paths[2] },
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
    await writeFile(resolve(root, `apps/worker/dist/job-snapshot-fault-${fault}.log`), output);
    assert.equal(code, 1, `Source fault escaped actual oracle: ${output}`);
    const oracle = {
      "full-grant": "Incomplete owner grant exposed a leased snapshot",
      "after-read": "Changed snapshot authority released bytes after a blocked read",
      member: "Staged hash escaped assigned base membership",
    }[fault];
    assert.ok(
      output.includes(oracle),
      `Fault ${fault} failed for another reason: ${output.slice(-3000)}`,
    );
    process.stdout.write(`${fault}: intended actual workerd oracle detected source fault\n`);
  }
} finally {
  for (const path of paths) await unlink(path).catch(() => {});
}
