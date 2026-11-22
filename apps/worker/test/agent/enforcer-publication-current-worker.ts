import type { Env } from "../../src/boundary/env.js";
import type { JobState } from "../../src/execution/jobs.js";
import { TestAgentSession as RuntimeAgent } from "./runtime-worker.js";

export {
  ControlPlane,
  default,
  LinuxContainerHost,
  StorageGuardProbe,
  WorkspaceObject,
  WorkspaceProxy,
} from "./runtime-worker.js";

interface ReadGate {
  jobId: string;
  credentialId: string;
  authorizedAt?: number;
  credentialExpiresAt?: number | null;
  readAt?: number;
  entered: boolean;
  release: ReturnType<typeof Promise.withResolvers<void>>;
}

export class TestAgentSession extends RuntimeAgent {
  #readGate: ReadGate | undefined;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const authorize = this.authority.authorize.bind(this.authority);
    this.authority.authorize = async (...args) => {
      await authorize(...args);
      const gate = this.#readGate;
      if (gate?.credentialId === args[0].credentialId && args[1] === "jobs.read") {
        gate.authorizedAt = Date.now();
        gate.credentialExpiresAt = args[0].credentialExpiresAt;
      }
    };
    const state = this.jobs.state.bind(this.jobs);
    this.jobs.state = async (...args) => {
      const result = await state(...args);
      const gate = this.#readGate;
      if (
        gate?.jobId === args[0] &&
        args[1] === undefined &&
        gate.authorizedAt !== undefined &&
        !gate.entered
      ) {
        // The real queued payload read has completed. Hold its return outside
        // the transaction/queue, before any caller's final publication guard.
        gate.entered = true;
        gate.readAt = Date.now();
        await gate.release.promise;
      }
      return result;
    };
  }
  armJobRead(jobId: string, credentialId: string) {
    this.#readGate = {
      jobId,
      credentialId,
      entered: false,
      release: Promise.withResolvers<void>(),
    };
  }
  jobReadGate() {
    const gate = this.#readGate;
    return {
      entered: gate?.entered ?? false,
      authorizedAt: gate?.authorizedAt ?? null,
      readAt: gate?.readAt ?? null,
      credentialExpiresAt: gate?.credentialExpiresAt ?? null,
    };
  }
  async queuedJobRead(jobId: string) {
    return (await this.store.get<JobState>("job", jobId))?.job.jobId;
  }
  releaseJobRead() {
    this.#readGate?.release.resolve();
    this.#readGate = undefined;
  }
}
