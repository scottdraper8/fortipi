import type { DurableObject } from "cloudflare:workers";
import type * as D from "../../../src/boundary/dto.js";
import type { Env } from "../../../src/boundary/env.js";
import { check, id, within } from "../../../src/control/store.js";
import { TestRecipient as BaseRecipient } from "./recipients.js";
import baseWorker, { TestControlPlane as BaseControl, type FixtureControl } from "./worker.js";

export class TestControlPlane extends BaseControl {
  async sampleBody(
    ctx: D.ResourceAuthContext,
    body: string,
    mode: "complete" | "abort" | "deadline",
  ): Promise<{ status: number; elapsed: number }> {
    const controller = new AbortController();
    const started = Date.now();
    let finish: ReturnType<typeof setTimeout> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(output) {
        const bytes = new TextEncoder().encode(body);
        output.enqueue(bytes.slice(0, 1));
        finish = setTimeout(
          () => {
            output.enqueue(bytes.slice(1));
            output.close();
          },
          mode === "complete" ? 20 : 300,
        );
      },
      cancel() {
        clearTimeout(finish);
        return new Promise<void>(() => {});
      },
    });
    const abort = mode === "abort" ? setTimeout(() => controller.abort(), 30) : undefined;
    try {
      const response = await within(
        this.fetch(
          new Request("https://control.internal/internal/storage-sample", {
            method: "POST",
            signal: controller.signal,
            headers: {
              "X-Fortipi-Context": JSON.stringify({
                ...ctx,
                deadline: mode === "deadline" ? started + 60 : ctx.deadline,
              }),
            },
            body: stream,
          }),
        ),
        1500,
      );
      return { status: response.status, elapsed: Date.now() - started };
    } finally {
      clearTimeout(finish);
      clearTimeout(abort);
    }
  }
  async budgetState(): Promise<string> {
    return JSON.stringify({
      usage: this.directory.budget.usage(),
      allocations: this.store.page("storage_allocation", 0, 100),
    });
  }
  async failBudget(kind: "storage_allocation" | "storage_sample" | null): Promise<void> {
    this.ctx.storage.sql.exec("DROP TRIGGER IF EXISTS budget_refusal");
    if (kind)
      this.ctx.storage.sql.exec(
        `CREATE TRIGGER budget_refusal BEFORE INSERT ON cp_records WHEN NEW.kind='${kind}' BEGIN SELECT RAISE(ABORT,'quota fixture refusal'); END`,
      );
  }
  async ageBudget(agentId: string): Promise<void> {
    this.ctx.storage.sql.exec(
      "UPDATE cp_records SET value=json_set(value,'$.observedAt',?) WHERE kind='storage_allocation' AND key=?",
      Date.now() - 31000,
      `agent:${agentId}`,
    );
  }
  async peerStorage(
    agentId: string,
    payload?: string,
  ): Promise<{ bytes: number; observedAt: number }> {
    const response = await this.env.AGENT_SESSIONS.getByName(agentId).fetch(
      new Request("https://fixture.internal/__budget-peer", {
        method: "POST",
        body: payload ?? "",
      }),
    );
    const result: unknown = await response.json();
    check(
      result &&
        typeof result === "object" &&
        "bytes" in result &&
        typeof result.bytes === "number" &&
        "observedAt" in result &&
        typeof result.observedAt === "number",
      "internal",
      "Missing actual peer observation",
    );
    return { bytes: result.bytes, observedAt: result.observedAt };
  }
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/__budget-allocation/"))
      return Response.json(
        this.store.get(
          "storage_allocation",
          `workspace:${url.pathname.slice("/__budget-allocation/".length)}`,
        ) ?? null,
      );
    return super.fetch(request);
  }
}
export type BudgetControl = FixtureControl &
  Pick<TestControlPlane, "budgetState" | "failBudget" | "peerStorage" | "ageBudget" | "sampleBody">;

/** Controlled peer, real public SQLite/KV size; this is not a Pi or Computer runtime. */
export class TestRecipient extends BaseRecipient {
  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== "/__budget-peer") return super.fetch(request);
    const payload = await request.text();
    if (payload) await this.ctx.storage.put("budget_peer_bytes", payload);
    return Response.json({ bytes: this.ctx.storage.sql.databaseSize, observedAt: Date.now() });
  }
  override async applyBinding(
    ctx: D.ResourceAuthContext,
    input: D.WorkspaceBindingApplication,
  ): Promise<D.Outcome<D.WorkspaceBinding>> {
    const response = await this.env.CONTROL_PLANE.getByName("control").fetch(
      new Request(`https://fixture.internal/__budget-allocation/${input.binding.workspaceId}`),
    );
    const allocation: unknown = await response.json();
    check(allocation !== null, "conflict", "Workspace floor must precede the first recipient RPC");
    return super.applyBinding(ctx, input);
  }
}

interface TestEnv extends Omit<Env, "CONTROL_PLANE"> {
  CONTROL_PLANE: DurableObjectNamespace<DurableObject<Env> & BudgetControl>;
}
export default {
  async fetch(request: Request, env: TestEnv): Promise<Response> {
    const url = new URL(request.url),
      cp = env.CONTROL_PLANE.getByName("control");
    if (url.pathname === "/budget-state")
      return new Response(await cp.budgetState(), {
        headers: { "Content-Type": "application/json" },
      });
    if (url.pathname === "/budget-create") {
      const auth = await cp.authenticate({
        bearer: env.FORTIPI_ADMIN_TOKEN,
        deploymentId: await cp.deployment(),
        requestId: id(),
        deadline: Date.now() + 30000,
      });
      if (!auth.ok) return Response.json(auth, { status: 401 });
      return Response.json(
        await cp.createAgent(auth.value, {
          operationId: "createAgent",
          path: {},
          query: {},
          body: {
            requestId: "persistent_allocation",
            name: "Retained allocation",
            model: { providerId: "cloudflare", modelId: "fixture" },
          },
        }),
      );
    }
    return baseWorker.fetch(request, env);
  },
};
