import type { ArtifactControl } from "./artifacts.js";
import { TestControlPlane as BaseControlPlane } from "./artifacts.js";

export { default, TestRecipient } from "./artifacts.js";

/** Count successful admissions, including actual alarms, without changing any bound. */
export class TestControlPlane extends BaseControlPlane {
  #counts = { application: 0, repair: 0 };
  constructor(ctx: DurableObjectState, env: ConstructorParameters<typeof BaseControlPlane>[1]) {
    super(ctx, env);
    const application = this.capacity.admitRequest.bind(this.capacity);
    const repair = this.capacity.admitRepair.bind(this.capacity);
    this.capacity.admitRequest = (principal) => {
      application(principal);
      this.#counts.application++;
    };
    this.capacity.admitRepair = () => {
      repair();
      this.#counts.repair++;
    };
  }
  async admissions(): Promise<{ application: number; repair: number }> {
    return { ...this.#counts };
  }
}
export type CompletionControl = ArtifactControl & Pick<TestControlPlane, "admissions">;
