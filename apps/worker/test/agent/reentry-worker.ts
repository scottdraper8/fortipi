import { DurableObject, RpcTarget } from "cloudflare:workers";

interface Env {
  PROBES: DurableObjectNamespace<ReentryProbe>;
  CALLERS: DurableObjectNamespace<ReentryCaller>;
}

class ReentryCallback extends RpcTarget {
  #calls = 0;
  ping(): number {
    return ++this.#calls;
  }
}

export class ReentryCaller extends DurableObject<Env> {
  async call(callback: ReentryCallback, count: number): Promise<number[]> {
    const values = [await callback.ping()];
    if (count === 2) values.push(await callback.ping());
    return values;
  }
}

export class ReentryProbe extends DurableObject<Env> {
  #result: number[] | undefined;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const name = ctx.id.name;
      if (!name) throw new Error("Named probe required");
      this.#result = await env.CALLERS.getByName(name).call(
        new ReentryCallback(),
        name === "once" ? 1 : 2,
      );
    });
  }
  fetch(): Response {
    return Response.json(this.#result);
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return env.PROBES.getByName(new URL(request.url).pathname.slice(1)).fetch(request);
  },
};
