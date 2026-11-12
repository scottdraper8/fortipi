import type { Sql } from "../../src/agent/store.js";
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
  selectedAt?: number;
  currentEnteredAt?: number;
  floorReadAt?: number;
  metadataReadAt?: number;
  currentFinishedAt?: number;
  credentialExpiresAt?: number | null;
  deadline?: number;
  registered?: boolean;
  permanentGrants?: boolean;
  entered: boolean;
  currentSucceeded: boolean;
  release: ReturnType<typeof Promise.withResolvers<void>>;
}

export class TestAgentSession extends RuntimeAgent {
  #gate: ReadGate | undefined;
  #currentGate: ReadGate | undefined;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const authorize = this.authority.authorize.bind(this.authority);
    this.authority.authorize = async (...args) => {
      await authorize(...args);
      const gate = this.#gate;
      if (gate?.credentialId === args[0].credentialId && args[1] === "jobs.read")
        gate.authorizedAt = Date.now();
    };
    const publish = this.jobs.public.bind(this.jobs);
    this.jobs.public = (job) => {
      const result = publish(job);
      const gate = this.#gate;
      if (gate?.jobId === job.jobId && gate.authorizedAt !== undefined)
        gate.selectedAt ??= Date.now();
      return result;
    };
    const current = this.authority.current.bind(this.authority);
    this.authority.current = async (...args) => {
      const gate = this.#gate;
      if (
        !gate ||
        gate.credentialId !== args[0].credentialId ||
        gate.selectedAt === undefined ||
        !args[1].actions.includes("jobs.read") ||
        args[2] !== undefined ||
        gate.entered
      )
        return current(...args);
      gate.currentEnteredAt = Date.now();
      gate.credentialExpiresAt = args[0].credentialExpiresAt;
      gate.deadline = args[0].deadline;
      gate.registered = !!args[0].registrationId;
      gate.permanentGrants =
        args[0].grants.length > 0 && args[0].grants.every((grant) => grant.expiresAt === undefined);
      this.#currentGate = gate;
      try {
        await current(...args);
        gate.currentSucceeded = true;
      } finally {
        gate.currentFinishedAt = Date.now();
        this.#currentGate = undefined;
      }
    };
    const get = this.store.get.bind(this.store);
    this.store.get = async <T>(kind: string, key: string, tx?: Sql): Promise<T | undefined> => {
      const gate = this.#currentGate;
      const floor = gate && kind === "credential-floor" && key === gate.credentialId;
      const metadata = gate && kind === "meta" && key === "deployment" && tx === undefined;
      const result = await get<T>(kind, key, tx);
      if (floor) gate.floorReadAt = Date.now();
      if (metadata && !gate.entered) {
        // The final current() has passed its initial time guard and completed
        // both actual Store reads. Hold only this unchanged metadata return,
        // outside the SQLite queue/transaction, inside that authority check.
        gate.entered = true;
        gate.metadataReadAt = Date.now();
        await gate.release.promise;
      }
      return result;
    };
  }
  armCurrentExpiry(jobId: string, credentialId: string) {
    this.#gate = {
      jobId,
      credentialId,
      entered: false,
      currentSucceeded: false,
      release: Promise.withResolvers<void>(),
    };
  }
  currentExpiryGate() {
    const gate = this.#gate;
    return {
      entered: gate?.entered ?? false,
      authorizedAt: gate?.authorizedAt ?? null,
      selectedAt: gate?.selectedAt ?? null,
      currentEnteredAt: gate?.currentEnteredAt ?? null,
      floorReadAt: gate?.floorReadAt ?? null,
      metadataReadAt: gate?.metadataReadAt ?? null,
      currentFinishedAt: gate?.currentFinishedAt ?? null,
      credentialExpiresAt: gate?.credentialExpiresAt ?? null,
      deadline: gate?.deadline ?? null,
      registered: gate?.registered ?? false,
      permanentGrants: gate?.permanentGrants ?? false,
      currentSucceeded: gate?.currentSucceeded ?? false,
    };
  }
  async queuedJobRead(jobId: string) {
    return (await this.store.get<JobState>("job", jobId))?.job.jobId;
  }
  releaseCurrentExpiry() {
    this.#gate?.release.resolve();
  }
}
