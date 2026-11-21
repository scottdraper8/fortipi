import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "agents/lifecycle";

interface Env {
  PROBE: DurableObjectNamespace<FetchErrorProbe>;
  FAILURE_MARKER: string;
  TEST_TOKEN: string;
}

export class FetchErrorProbe extends DurableObject<Env> {
  readonly lifecycle = Lifecycle.install(this);
  private hostStarts = 0;
  private capabilityStarts = 0;
  private capabilityRequests = 0;
  private capabilityUpgrades = 0;
  private hostRequests = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.lifecycle.use({
      onStart: () => {
        this.capabilityStarts++;
        if (this.phase() === "capability-start") this.fail();
      },
      onRequest: () => {
        this.capabilityRequests++;
        if (this.phase() === "capability") this.fail();
      },
      onWebSocketUpgrade: () => {
        this.capabilityUpgrades++;
        if (this.phase() === "capability") this.fail();
      },
    });
  }

  private phase() {
    return this.ctx.id.name?.split("/")[0];
  }

  private fail(): never {
    throw new Error(this.env.FAILURE_MARKER);
  }

  onStart() {
    this.hostStarts++;
    if (this.phase() === "host-start") this.fail();
  }

  onRequest() {
    this.hostRequests++;
    return new Response("host reached");
  }

  observe() {
    // Native RPC deliberately observes without calling Lifecycle.start().
    return JSON.stringify({
      hostStarts: this.hostStarts,
      capabilityStarts: this.capabilityStarts,
      capabilityRequests: this.capabilityRequests,
      capabilityUpgrades: this.capabilityUpgrades,
      hostRequests: this.hostRequests,
    });
  }
}

export default {
  fetch(request: Request, env: Env) {
    if (request.headers.get("Authorization") !== `Bearer ${env.TEST_TOKEN}`)
      return new Response(null, { status: 403 });
    const name = new URL(request.url).pathname.slice(1);
    if (!/^(host-start|capability-start|capability|healthy)\/(http|ws)$/.test(name))
      return new Response(null, { status: 404 });
    return env.PROBE.getByName(name).fetch(request);
  },
} satisfies ExportedHandler<Env>;
