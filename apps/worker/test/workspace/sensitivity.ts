import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { root } from "./harness.ts";

const source = resolve(root, "apps/worker/src/workspace");
const tests = resolve(root, "apps/worker/test/workspace");
const paths = [
  resolve(source, ".sensitivity-authority.ts"),
  resolve(source, ".sensitivity-computer.ts"),
  resolve(source, ".sensitivity-workspace-object.ts"),
  resolve(tests, ".sensitivity-runtime-worker.ts"),
];
async function run(
  file: string,
  pattern?: string,
): Promise<{ code: number | null; output: string }> {
  const child = spawn(
    process.execPath,
    ["--test", ...(pattern ? [`--test-name-pattern=${pattern}`] : []), resolve(tests, file)],
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
    child.once("error", reject);
    child.once("exit", resolve);
  });
  return { code, output };
}
const authority = await readFile(resolve(source, "authority.ts"), "utf8");
const computer = await readFile(resolve(source, "computer.ts"), "utf8");
const workspace = await readFile(resolve(source, "workspace-object.ts"), "utf8");
const fixture = await readFile(resolve(tests, "runtime-worker.ts"), "utf8");
await mkdir(resolve(root, "apps/worker/dist"), { recursive: true });
try {
  for (const mutant of ["generation", "expiry", "seal"] as const) {
    let changedAuthority = authority;
    let changedComputer = computer;
    if (mutant === "generation")
      changedAuthority = authority.replace(
        /active\.executorGeneration\s*>=\s*\(state\.get<number>\(`floor:executor:\$\{active\.executorId\}`\) \?\? 0\)/,
        "true",
      );
    if (mutant === "expiry")
      changedAuthority = authority.replace("active && active.expiresAt > Date.now()", "active");
    if (mutant === "seal")
      changedComputer = computer.replace(
        'state.state === "writable" &&',
        '(state.state === "writable" || state.state === "sealed") &&',
      );
    assert.ok(
      changedAuthority !== authority || changedComputer !== computer,
      `Mutation ${mutant} did not apply`,
    );
    await writeFile(paths[0] ?? "", changedAuthority);
    await writeFile(paths[1] ?? "", changedComputer);
    await writeFile(
      paths[2] ?? "",
      workspace
        .replace('from "./authority.js"', 'from "./.sensitivity-authority.js"')
        .replace('from "./computer.js"', 'from "./.sensitivity-computer.js"'),
    );
    await writeFile(
      paths[3] ?? "",
      fixture.replace(
        'from "../../src/workspace/workspace-object.js"',
        'from "../../src/workspace/.sensitivity-workspace-object.js"',
      ),
    );
    const result = await run(
      mutant === "generation" ? "workspace.test.ts" : "isolation.test.ts",
      mutant === "generation" ? undefined : "sealed children",
    );
    await writeFile(resolve(root, `apps/worker/dist/sensitivity-${mutant}.log`), result.output);
    assert.notEqual(result.code, 0, `The ${mutant} regression escaped the real runtime oracle`);
    assert.ok(
      result.output.includes(
        mutant === "seal"
          ? "Sealed-store mutation was accepted"
          : mutant === "expiry"
            ? "Expired lease published a revision"
            : "Revoked generation published a revision",
      ),
      `Mutation failed for an unintended reason: ${result.output.slice(-3000)}`,
    );
    process.stdout.write(`${mutant}: real runtime oracle rejected the disposable regression\n`);
  }
} finally {
  for (const path of paths) await unlink(path).catch(() => {});
}
