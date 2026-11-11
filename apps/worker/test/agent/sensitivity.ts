import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import type * as D from "../../src/boundary/dto.js";
import { eventually } from "./harness.ts";
import { processHarness } from "./process-harness.ts";

type Fault = "baseline" | "unstable-admission" | "split-child";
const barrier = `if(await jobs.store.get("fixture","fault")==="after-child"){
  await jobs.store.transaction(async tx=>{await jobs.store.remove("fixture","fault",tx);await jobs.store.put("fixture","barrier","after-child",tx);});
  await new Promise(accept=>setTimeout(accept,300000));
}`;
async function bundle(directory: string, fault: Fault) {
  let mutations = 0;
  const outfile = join(directory, `${fault}.js`);
  await build({
    entryPoints: [resolve("apps/worker/test/agent/runtime-worker.ts")],
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
        name: "owned-source-sensitivity",
        setup(builder) {
          builder.onLoad(
            { filter: /src\/(agent\/conversations|execution\/registry)\.ts$/ },
            async (args) => {
              let contents = await readFile(args.path, "utf8");
              if (args.path.endsWith("conversations.ts") && fault === "unstable-admission") {
                const needle =
                  /(\.submit\(admission\.content,\s*\{\s*operationId:\s*)admission\.operationId,/g;
                assert.equal([...contents.matchAll(needle)].length, 1);
                contents = contents.replace(needle, '$1resourceId("m", this.host.agentId),');
                mutations++;
              }
              if (args.path.endsWith("registry.ts")) {
                // Candidate safe policy is tested only in disposable output. Product stays
                // unsafe until independent executor/ledger/fence proofs also pass.
                assert.ok(contents.includes('replay: "unsafe"'));
                contents = contents.replace('replay: "unsafe"', 'replay: "safe"');
                const start = contents.indexOf(
                  "      const childId = await api.commit(async (tx) => {",
                );
                const end = contents.indexOf("      context.abortSignal?.throwIfAborted();", start);
                assert.ok(start >= 0 && end > start);
                if (fault === "split-child") {
                  contents =
                    contents.slice(0, start) +
                    `const oldReference=await api.snapshot(ChildDoc,api.taskId,context);
          let childId=oldReference?.child;
          if(childId==null){
            childId=await api.commit(tx=>tx.createTask(dispatchTask,{jobId:intent.jobId},{ownership:{kind:"task",taskId:api.taskId},abandonOnRestart:false}),context);
            ${barrier}
            await api.commit(async tx=>{const doc=await tx.doc(ChildDoc,api.taskId);doc.child=childId;},context);
          }
          ` +
                    contents.slice(end);
                  mutations++;
                } else contents = contents.slice(0, end) + barrier + contents.slice(end);
              }
              return { contents, loader: "ts" };
            },
          );
        },
      },
    ],
  });
  assert.equal(mutations, fault === "baseline" ? 0 : 1);
  return outfile;
}
async function scenario(main: string, kind: "admission" | "child") {
  const h = await processHarness(main);
  try {
    const agent = await h.api<D.Agent>("/v1/agents", {
      requestId: crypto.randomUUID(),
      name: "sensitivity",
      model: { providerId: "cloudflare", modelId: "@cf/zai-org/glm-5.3-flash" },
    });
    assert.equal(agent.status, 201);
    const created = await h.api<D.Conversation>(`/v1/agents/${agent.body.agentId}/conversations`, {
      requestId: crypto.randomUUID(),
    });
    assert.equal(created.status, 201);
    const cid = created.body.conversationId,
      probe = `/__test/agents/${agent.body.agentId}`;
    if (kind === "child") {
      const binding = await h.api<D.WorkspaceBinding>("/v1/workspaces", {
        requestId: crypto.randomUUID(),
        config: { kind: "computer" },
      });
      assert.equal(binding.status, 201);
      await h.api(`${probe}/tool`, {
        tool: "javascript",
        arguments: { code: "return 42" },
        workspaceId: binding.body.workspaceId,
        baseRevision: binding.body.revision,
        target: { kind: "backend", backendId: "cloud", generation: 1 },
        capabilities: ["javascript"],
      });
    }
    const point = kind === "admission" ? "after-submit" : "after-child";
    await h.api(`${probe}/fault`, point);
    const input = {
      clientRequestId: crypto.randomUUID(),
      content: "sensitivity-input",
      busyBehavior: "followUp",
    };
    const lost = h.api(`/v1/conversations/${cid}/messages`, input).catch(() => undefined);
    await eventually(
      async () => (await h.api<{ barrier: string }>(`${probe}/state`)).body,
      (s) => s.barrier === point,
    );
    await h.crash();
    await lost;
    await h.start();
    if (kind === "admission") {
      // A missing stable identity may fail its reply; count committed Pi effects anyway.
      const response = await h.api(`/v1/conversations/${cid}/messages`, input);
      const actual = await eventually(
        async () => (await h.api<{ inputSubmissions: number }>(`${probe}/inspect?cid=${cid}`)).body,
        (s) => s.inputSubmissions >= (response.status === 202 ? 1 : 2),
      );
      return actual.inputSubmissions;
    }
    const actual = await eventually(
      async () =>
        (
          await h.api<{ tasks: { kind: string }[]; jobs: { state: string }[] }>(
            `${probe}/tool-state?cid=${cid}`,
          )
        ).body,
      (s) => s.jobs[0]?.state === "awaiting_approval",
    );
    return actual.tasks.filter((task) => task.kind === "fortipi.dispatch").length;
  } finally {
    await h.close();
  }
}
const directory = await mkdtemp(join(tmpdir(), "fortipi-sensitivity-"));
try {
  const baseline = await bundle(directory, "baseline");
  for (const kind of ["admission", "child"] as const) {
    const positive = await scenario(baseline, kind);
    assert.equal(positive, 1, `${kind}: restored source must preserve one actual persisted effect`);
    const fault = kind === "admission" ? "unstable-admission" : "split-child";
    const negative = await scenario(await bundle(directory, fault), kind);
    assert.ok(
      negative > 1,
      `${fault}: must expose actual duplicates, not compilation failure or timeout`,
    );
    console.log(
      JSON.stringify({
        kind,
        baselineCount: positive,
        faultCount: negative,
        oracle: "actual committed Pi entries/tasks after SIGKILL",
      }),
    );
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
