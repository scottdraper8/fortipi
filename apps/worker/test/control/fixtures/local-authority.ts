import type * as D from "../../../src/boundary/dto.js";
import { WorkspaceObject } from "../../../src/workspace/workspace-object.js";

export { default, TestControlPlane, TestRecipient } from "./worker.js";

/** Real Source3 binding/lease/prepare; only its return scheduling is controlled. */
export class TestWorkspace extends WorkspaceObject {
  #gate: Promise<void> | undefined;
  #release: (() => void) | undefined;
  #entered = false;
  #captured: D.AuthContext | undefined;
  override async prepareLocalCommit(
    ctx: D.AuthContext,
    input: Parameters<WorkspaceObject["prepareLocalCommit"]>[1],
  ) {
    const result = await super.prepareLocalCommit(ctx, input);
    this.#captured = ctx;
    if (result.ok && this.#gate) {
      this.#entered = true;
      await this.#gate;
    }
    return result;
  }
  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/fixture/prepare") {
      if (request.method === "POST") {
        if ((await request.text()) === "hold") {
          this.#entered = false;
          this.#gate = new Promise<void>((resolve) => {
            this.#release = resolve;
          });
        } else {
          this.#release?.();
          this.#gate = undefined;
          this.#release = undefined;
        }
      }
      return Response.json({ entered: this.#entered, auth: this.#captured });
    }
    return super.fetch(request);
  }
}
