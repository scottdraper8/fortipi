import type * as D from "../../../src/boundary/dto.js";
import { check } from "../../../src/control/store.js";
import { TestControlPlane as BaseControlPlane } from "./worker.js";

export { default, TestRecipient } from "./worker.js";

export class TestControlPlane extends BaseControlPlane {
  async raceUpgrade(admin: D.AuthContext, identity: D.SocketIdentity): Promise<boolean> {
    const attaching = this.executors.upgrade(identity).then(
      () => true,
      () => false,
    );
    // Order the real revocation transaction after the initial identity check,
    // before upgrade resumes from its actual storage await. No clock/storage patch.
    const revocation = this.revocations.begin(admin, "credential", identity.credentialId, {
      requestId: "upgrade-revoke",
      expectedGeneration: identity.generation,
    });
    await this.revocations.publish(revocation);
    return attaching;
  }
  async raceRegistration(
    admin: D.AuthContext,
    frame: Extract<D.ExecutorFrame, { type: "executor.register" }>,
  ): Promise<{ generation: number; status: string; registrationSucceeded: boolean }> {
    const socket = this.ctx.getWebSockets("executor")[0];
    check(socket, "internal", "Missing actual socket");
    const outcomes = await Promise.allSettled([
      this.revocations.revoke(admin, "executor", "executor", {
        requestId: "race-revoke",
        expectedGeneration: 1,
      }),
      this.executors.message(socket, JSON.stringify(frame)),
    ]);
    const row = this.store.get<{ generation: number; status: string }>("executor", "executor");
    check(row, "internal", "Missing executor row");
    return { ...row, registrationSucceeded: outcomes[1]?.status === "fulfilled" };
  }
}
