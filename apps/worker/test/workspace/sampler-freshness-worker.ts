import type * as D from "../../src/boundary/dto.js";
import type { WorkspaceStorageSample } from "../../src/boundary/infrastructure.js";
import { WorkspaceStorage } from "../../src/workspace/storage.js";
import { internalHeader } from "../../src/workspace/workspace-object.js";
import { HostProbe } from "../backends/host-rpc-worker.js";
import {
  ControlFixture as FixtureControl,
  WorkspaceObject as FixtureWorkspace,
} from "./runtime-worker.js";

export { default } from "./runtime-worker.js";
/** Observe sender calls; never fabricate a CP settlement/sample acknowledgment. */
export class ControlFixture extends FixtureControl {
  override async fetch(_request: Request) {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS fp_sampler_report_calls(marker INTEGER)");
    this.ctx.storage.sql.exec("INSERT INTO fp_sampler_report_calls VALUES(1)");
    return new Response(null, { status: 503 });
  }
}

/** Lose a reply only AFTER the actual product leaf has durably cached its observation. */
class ReplyBarrier {
  #armed = false;
  #release: ((drop: boolean) => void) | undefined;
  sample: Pick<WorkspaceStorageSample, "bytes" | "observedAt" | "sampleId"> | undefined;
  arm() {
    this.#armed = true;
    this.sample = undefined;
  }
  waiting() {
    return Boolean(this.#release);
  }
  release(drop: boolean) {
    this.#release?.(drop);
  }
  async after(response: Response) {
    if (!this.#armed || !response.ok) return response;
    this.#armed = false;
    this.sample = await response.clone().json();
    const drop = await new Promise<boolean>((resolve) => {
      this.#release = resolve;
    });
    this.#release = undefined;
    return drop ? new Response(null, { status: 503 }) : response;
  }
}
export class FreshnessHost extends HostProbe {
  #reply = new ReplyBarrier();
  armReply() {
    this.#reply.arm();
  }
  replyWaiting() {
    return this.#reply.waiting();
  }
  heldSample() {
    return this.#reply.sample;
  }
  releaseReply(drop: boolean) {
    this.#reply.release(drop);
  }
  override async fetch(request: Request) {
    const response = await super.fetch(request);
    return new URL(request.url).pathname === "/__fortipi/storage-sample"
      ? this.#reply.after(response)
      : response;
  }
}
export class WorkspaceObject extends FixtureWorkspace {
  #reply = new ReplyBarrier();
  armReply() {
    this.#reply.arm();
  }
  replyWaiting() {
    return this.#reply.waiting();
  }
  heldSample() {
    return this.#reply.sample;
  }
  releaseReply(drop: boolean) {
    this.#reply.release(drop);
  }
  growMetadata() {
    this.state.storage.sql.exec("CREATE TABLE IF NOT EXISTS fp_sampler_growth(bytes BLOB)");
    this.state.storage.sql.exec("INSERT INTO fp_sampler_growth VALUES(zeroblob(262144))");
  }
  override async fetch(request: Request) {
    if (new URL(request.url).pathname === "/__test/storage-report-send") {
      const { auth } = JSON.parse(request.headers.get(internalHeader) ?? "null") as {
        auth: D.AuthContext;
      };
      await new WorkspaceStorage(this).report(auth);
      return new Response(null, { status: 204 });
    }
    const response = await super.fetch(request);
    return this.state.get("child") && new URL(request.url).pathname === "/__fortipi/storage-sample"
      ? this.#reply.after(response)
      : response;
  }
}
