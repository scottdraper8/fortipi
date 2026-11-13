import { AsyncLocalStorage } from "node:async_hooks";
import type * as D from "../../../src/boundary/dto.js";
import type { ArtifactControl } from "./artifacts.js";
import { TestControlPlane as BaseControlPlane } from "./artifacts.js";

export { default, TestRecipient } from "./artifacts.js";

interface Admissions {
  application: number;
  repair: number;
}

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
    "admissions" | "queryExecutionWithAdmissions" | "cancelExecutionWithAdmissions"
  >;
