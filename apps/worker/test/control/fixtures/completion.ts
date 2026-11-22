import { AsyncLocalStorage } from "node:async_hooks";
import type * as D from "../../../src/boundary/dto.js";
import type { ArtifactControl } from "./artifacts.js";
import { TestControlPlane as BaseControlPlane } from "./artifacts.js";

export { default, TestRecipient } from "./artifacts.js";

interface Admissions {
  application: number;
  repair: number;
}

const realNow = Date.now;

/** Count successful admissions, including actual alarms, without changing any bound. */
export class TestControlPlane extends BaseControlPlane {
  #counts = { application: 0, repair: 0 };
  #foreground = new AsyncLocalStorage<Admissions>();
  constructor(ctx: DurableObjectState, env: ConstructorParameters<typeof BaseControlPlane>[1]) {
    super(ctx, env);
    const application = this.capacity.admitRequest.bind(this.capacity);
    const repair = this.capacity.admitRepair.bind(this.capacity);
    this.capacity.admitRequest = (principal) => {
      application(principal);
      this.#counts.application++;
      const foreground = this.#foreground.getStore();
      if (foreground) foreground.application++;
    };
    this.capacity.admitRepair = () => {
      repair();
      this.#counts.repair++;
      const foreground = this.#foreground.getStore();
      if (foreground) foreground.repair++;
    };
  }
  async admissions(): Promise<{ application: number; repair: number }> {
    return { ...this.#counts };
  }
  // Test-only clock for this disposable Worker (including its proof recipients).
  // Timers and transport are real. Other users of this fixture keep the real clock.
  async setTime(now: number | null): Promise<void> {
    if (now !== null && !Number.isSafeInteger(now)) throw new Error("Invalid fixture time");
    Date.now = now === null ? realNow : () => now;
  }
  async admissionWindow() {
    // Read the actual Capacity fields without triggering rollover or admission.
    const capacity = this.capacity as unknown as {
      readonly requestWindow: number;
      readonly applicationRequests: number;
      readonly repairRequests: number;
      readonly installRequests: number;
    };
    return {
      minute: capacity.requestWindow,
      application: capacity.applicationRequests,
      repair: capacity.repairRequests,
      install: capacity.installRequests,
    };
  }
  // Actual super methods await initialization before admitting. Context-local
  // counters follow that await without attributing independent alarm/RPC work.
  async #observe<T>(operation: () => Promise<T>) {
    const admissions: Admissions = { application: 0, repair: 0 };
    const result = await this.#foreground.run(admissions, operation);
    return { result, admissions: { ...admissions } };
  }
  async queryExecutionWithAdmissions(ctx: D.AuthContext, input: D.ExecutionIdentity) {
    return this.#observe(() => super.queryExecution(ctx, input));
  }
  async cancelExecutionWithAdmissions(ctx: D.AuthContext, input: D.CancelRequest) {
    return this.#observe(() => super.cancelExecution(ctx, input));
  }
}
export type CompletionControl = ArtifactControl &
  Pick<
    TestControlPlane,
    | "admissions"
    | "admissionWindow"
    | "setTime"
    | "queryExecutionWithAdmissions"
    | "cancelExecutionWithAdmissions"
  >;
