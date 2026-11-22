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
  resolve(source, ".sensitivity-terminal-proof.ts"),
  resolve(source, ".sensitivity-local-upload.ts"),
  resolve(tests, ".sensitivity-local-upload-worker.ts"),
  resolve(source, "../container/.sensitivity-host-transport.ts"),
  resolve(tests, "../backends/.sensitivity-host-rpc-worker.ts"),
  resolve(source, ".sensitivity-streams.ts"),
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
      env: {
        ...process.env,
        FORTIPI_TEST_ENTRY: paths[3],
        FORTIPI_LOCAL_TEST_ENTRY: paths[6],
        FORTIPI_HOST_TEST_ENTRY: paths[8],
      },
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
const terminal = await readFile(resolve(source, "terminal-proof.ts"), "utf8");
const local = await readFile(resolve(source, "local-upload.ts"), "utf8");
const localFixture = await readFile(resolve(tests, "local-upload-worker.ts"), "utf8");
const hostTransport = await readFile(resolve(source, "../container/host-transport.ts"), "utf8");
const hostFixture = await readFile(resolve(tests, "../backends/host-rpc-worker.ts"), "utf8");
const streams = await readFile(resolve(source, "streams.ts"), "utf8");
await mkdir(resolve(root, "apps/worker/dist"), { recursive: true });
try {
  for (const mutant of [
    "generation",
    "expiry",
    "seal",
    "writer-receipt",
    "terminal-scope",
    "empty-announcement",
    "local-upload-digest",
    "host-allocation",
    "host-image",
    "host-start-order",
    "byte-length",
    "receipt-read",
    "public-receipt",
    "fact-conversation",
    "metadata-scope",
    "metadata-base",
    "metadata-before-lock",
  ] as const) {
    let changedAuthority = authority;
    let changedComputer = computer;
    let changedWorkspace = workspace;
    let changedLocal = local;
    let changedHost = hostTransport;
    const changedStreams =
      mutant === "byte-length"
        ? streams.replace(
            "return source.pipeThrough(new FixedLengthStream(length));",
            "return source;",
          )
        : streams;
    if (mutant === "host-allocation")
      changedHost = hostTransport.replace("current?.runtimeId === runtimeId &&", "current &&");
    if (mutant === "host-image")
      changedHost = hostTransport.replace("current.image === image &&", "true &&");
    if (mutant === "host-start-order")
      changedHost = hostTransport.replace("await previous;", "void previous;");
    if (mutant === "empty-announcement")
      changedLocal = local.replace("if (mutation.size !== 0) continue;", "continue;");
    if (mutant === "local-upload-digest")
      changedWorkspace = workspace.replace("...(uploadId ? { uploadId } : {}),", "...{},");
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
    if (mutant === "writer-receipt")
      changedWorkspace = workspace.replace(
        'this.#receipt(ctx, input, "workspace.write")',
        "this.#receipt(ctx, input)",
      );
    if (mutant === "receipt-read")
      changedWorkspace = workspace.replace('return "workspace.write";', 'return "workspace.read";');
    if (mutant === "public-receipt") {
      const start = workspace.indexOf("  getCommitReceipt(");
      const end = workspace.indexOf("  transact(", start);
      assert.ok(start >= 0 && end > start);
      changedWorkspace =
        workspace.slice(0, start) +
        workspace
          .slice(start, end)
          .replace('"workspace.read"', "this.#receiptReadAction(ctx, input.path.workspaceId)") +
        workspace.slice(end);
    }
    if (mutant === "fact-conversation")
      changedWorkspace = workspace.replace(
        "permitsResource(grant.resources.conversationIds, fact.conversationId)",
        "true",
      );
    if (mutant.startsWith("metadata-")) {
      const start = workspace.indexOf(
        '      if (url.pathname === "/__fortipi/operational-metadata") {',
      );
      const end = workspace.indexOf(
        '      if (url.pathname === "/__fortipi/terminal-proof")',
        start,
      );
      assert.ok(start >= 0 && end > start);
      let block = workspace.slice(start, end);
      if (mutant === "metadata-scope")
        block = block.replace('permitsResource(grant.resources.actions, "jobs.dispatch")', "true");
      if (mutant === "metadata-base")
        block = block.replace(
          'binding.revision === url.searchParams.get("revision") &&',
          "true &&",
        );
      if (mutant === "metadata-before-lock")
        block = block
          .replace('authorize(this.state, auth, authority.workspaceId, "workspace.write");', "")
          .replace(
            "const metadata = await this.mutex.run(() => {",
            'authorize(this.state, auth, this.current().workspaceId, "workspace.write");\n        const metadata = await this.mutex.run(() => {',
          );
      changedWorkspace = workspace.slice(0, start) + block + workspace.slice(end);
    }
    if (mutant === "terminal-scope")
      changedAuthority = authority.replace(
        /\(!reservation\.conversationId\s*\|\|\s*permitsResource\(grant\.resources\.conversationIds, reservation\.conversationId\)\)/,
        "true",
      );
    assert.ok(
      changedAuthority !== authority ||
        changedComputer !== computer ||
        changedWorkspace !== workspace ||
        changedLocal !== local ||
        changedHost !== hostTransport ||
        changedStreams !== streams,
      `Mutation ${mutant} did not apply`,
    );
    await writeFile(paths[0] ?? "", changedAuthority);
    await writeFile(paths[1] ?? "", changedComputer);
    await writeFile(
      paths[2] ?? "",
      changedWorkspace
        .replace('from "./authority.js"', 'from "./.sensitivity-authority.js"')
        .replace('from "./computer.js"', 'from "./.sensitivity-computer.js"')
        .replace('from "./local-upload.js"', 'from "./.sensitivity-local-upload.js"')
        .replace('from "./streams.js"', 'from "./.sensitivity-streams.js"')
        .replace('from "./terminal-proof.js"', 'from "./.sensitivity-terminal-proof.js"'),
    );
    await writeFile(
      paths[4] ?? "",
      terminal.replace('from "./authority.js"', 'from "./.sensitivity-authority.js"'),
    );
    await writeFile(
      paths[3] ?? "",
      fixture.replace(
        'from "../../src/workspace/workspace-object.js"',
        'from "../../src/workspace/.sensitivity-workspace-object.js"',
      ),
    );
    await writeFile(
      paths[5] ?? "",
      changedLocal.replace('from "./authority.js"', 'from "./.sensitivity-authority.js"'),
    );
    await writeFile(
      paths[6] ?? "",
      localFixture.replaceAll(
        'from "./runtime-worker.ts"',
        'from "./.sensitivity-runtime-worker.ts"',
      ),
    );
    await writeFile(paths[7] ?? "", changedHost);
    await writeFile(paths[9] ?? "", changedStreams);
    await writeFile(
      paths[8] ?? "",
      hostFixture.replace(
        'from "../../src/container/host-transport.js"',
        'from "../../src/container/.sensitivity-host-transport.js"',
      ),
    );
    const result = await run(
      mutant.startsWith("host-")
        ? "../backends/host-rpc.test.ts"
        : mutant.startsWith("metadata-")
          ? "operational-metadata.test.ts"
          : mutant === "byte-length"
            ? "artifact-forward.test.ts"
            : mutant === "empty-announcement" || mutant === "local-upload-digest"
              ? "local-upload.test.ts"
              : mutant === "generation"
                ? "workspace.test.ts"
                : mutant === "expiry" || mutant === "seal"
                  ? "isolation.test.ts"
                  : "terminal-proof.test.ts",
      mutant === "expiry" || mutant === "seal" ? "sealed children" : undefined,
    );
    await writeFile(resolve(root, `apps/worker/dist/sensitivity-${mutant}.log`), result.output);
    assert.notEqual(result.code, 0, `The ${mutant} regression escaped the real runtime oracle`);
    assert.ok(
      result.output.includes(
        mutant === "host-allocation"
          ? "Container ownership check failed: stale-runtime"
          : mutant === "byte-length"
            ? "Native artifact lost declared Content-Length"
            : mutant === "host-image"
              ? "Container ownership check failed: changed-image"
              : mutant === "host-start-order"
                ? "Container replacement crossed an active native HTTP acquisition"
                : mutant === "empty-announcement"
                  ? "Local empty upload raced its transfer settlement"
                  : mutant === "local-upload-digest"
                    ? "Local receipt omitted its retained upload identity"
                    : mutant === "seal"
                      ? "Sealed-store mutation was accepted"
                      : mutant === "expiry"
                        ? "Expired lease published a revision"
                        : mutant === "generation"
                          ? "Revoked generation published a revision"
                          : mutant === "writer-receipt"
                            ? "Workspace grant required"
                            : mutant === "receipt-read"
                              ? "Write-only historical receipt lookup required public read"
                              : mutant === "public-receipt"
                                ? "Writer gained a public read capability"
                                : mutant === "fact-conversation"
                                  ? "Unrelated conversation received a workspace fact"
                                  : mutant === "metadata-scope"
                                    ? "Workspace write alone exposed operational metadata"
                                    : mutant === "metadata-base"
                                      ? "Operational metadata accepted a different expected base"
                                      : mutant === "metadata-before-lock"
                                        ? "Queued stale context exposed operational metadata"
                                        : "Wrong receipt scope was accepted: x-test-other-conversation",
      ),
      `Mutation failed for an unintended reason: ${result.output.slice(-3000)}`,
    );
    process.stdout.write(`${mutant}: real runtime oracle rejected the disposable regression\n`);
  }
} finally {
  for (const path of paths) await unlink(path).catch(() => {});
}
