import type * as D from "../../../src/boundary/dto.js";
import type { ArtifactControl } from "./artifacts.js";
import {
  TestControlPlane as BaseControlPlane,
  TestRecipient as BaseRecipient,
} from "./artifacts.js";

export { default } from "./artifacts.js";

export class TestRecipient extends BaseRecipient {
  #gate: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  #entered = false;
  #proofReads = 0;
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/fixture/recovery-reads") return Response.json(this.#proofReads);
    if (url.pathname === "/fixture/proof" && request.method === "POST") {
      const proof = (await request.clone().json()) as D.JobCommitted;
      await this.ctx.storage.put(`recovery-proof:${proof.identity.jobId}`, proof);
    }
    if (url.pathname === "/fixture/recovery-proof" && request.method === "DELETE") {
      await this.ctx.storage.delete(`recovery-proof:${url.searchParams.get("job")}`);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/fixture/recovery-gate") {
      if (request.method === "PUT") {
        this.#gate = Promise.withResolvers<void>();
        this.#entered = false;
      }
      if (request.method === "DELETE") {
        this.#gate?.resolve();
        this.#gate = undefined;
      }
      return Response.json({ entered: this.#entered });
    }
    if (
      this.#gate &&
      request.method === "POST" &&
      new URL(request.url).pathname.startsWith("/__fortipi/terminal-proof")
    ) {
      this.#entered = true;
      await this.#gate.promise;
    }
    if (request.method === "POST" && url.pathname.startsWith("/__fortipi/terminal-proof")) {
      this.#proofReads++;
      const supplied = (await request.clone().json()) as D.JobCommitted;
      const proof = await this.ctx.storage.get<D.JobCommitted>(
        `recovery-proof:${supplied.identity.jobId}`,
      );
      await this.ctx.storage.put("proof", proof ?? null);
    }
    return super.fetch(request);
  }
}

export class TestControlPlane extends BaseControlPlane {
  #drop = false;
  #dropped = 0;
  readonly #activeRecovery = new Set<number>();
  constructor(ctx: DurableObjectState, env: ConstructorParameters<typeof BaseControlPlane>[1]) {
    super(ctx, env);
    const recover = this.delivery.recoverTerminal.bind(this.delivery);
    this.delivery.recoverTerminal = async (...args) => {
      this.#activeRecovery.add(args[3]);
      try {
        await recover(...args);
      } finally {
        this.#activeRecovery.delete(args[3]);
      }
    };
    const send = this.executors.send.bind(this.executors);
    this.executors.send = (executorId, generation, frame) => {
      if (this.#drop && frame.type === "job.committed") {
        this.#drop = false;
        this.#dropped++;
        return;
      }
      send(executorId, generation, frame);
    };
  }
  async loseTerminalDelivery() {
    this.#drop = true;
  }
  async terminalState() {
    return JSON.stringify({
      dropped: this.#dropped,
      active: [...this.#activeRecovery],
      indexed: this.store.storage.sql
        .exec<{ n: number }>(
          "SELECT count(*) n FROM cp_records WHERE kind='command' AND recipient='terminal:executor:1'",
        )
        .one().n,
      commands: this.store
        .page<{
          delivery: D.ExecutorDelivery;
          ack: D.DeliveryAck;
          digest: string;
          peerApplied?: true;
        }>("command", 0, 100)
        .map((row) => ({
          seq: row.seq,
          key: row.key,
          recipient: row.recipient,
          epoch: row.value.delivery.connectionEpoch,
          frame: row.value.delivery.frame,
          ack: row.value.ack,
          digest: row.value.digest,
          peerApplied: row.value.peerApplied ?? false,
        })),
      recovery: this.store.get("terminal-recovery", "executor"),
      migration: this.store.get("migration", "terminal-command-recipient-v1"),
      plan: this.store.storage.sql
        .exec(
          "EXPLAIN QUERY PLAN SELECT seq,key,value FROM cp_records WHERE kind='command' AND recipient='terminal:executor:1' AND seq>0 ORDER BY seq LIMIT 4",
        )
        .toArray()
        .map((row) => row.detail),
    });
  }
  async legacyTerminalCommands() {
    for (const row of this.store.page("command", 0, 100))
      this.store.put("command", row.key, row.value, row.subject, "", row.due);
    this.store.remove("migration", "terminal-command-recipient-v1");
  }
  async drainTerminalCommands() {
    for (const row of this.store.page("command", 0, 100))
      await this.delivery.drainCommand(row.key, this.executors);
  }
  async refuseTerminalConfirmation(enabled: boolean) {
    this.store.storage.sql.exec("DROP TRIGGER IF EXISTS fixture_refuse_terminal_confirmation");
    if (enabled)
      this.store.storage.sql.exec(
        "CREATE TRIGGER fixture_refuse_terminal_confirmation BEFORE UPDATE ON cp_records WHEN NEW.kind='command' AND json_extract(NEW.value,'$.peerApplied')=1 BEGIN SELECT RAISE(ABORT,'synthetic terminal confirmation refusal'); END",
      );
  }
}

export type TerminalControl = ArtifactControl &
  Pick<
    TestControlPlane,
    | "loseTerminalDelivery"
    | "terminalState"
    | "legacyTerminalCommands"
    | "drainTerminalCommands"
    | "refuseTerminalConfirmation"
  >;
