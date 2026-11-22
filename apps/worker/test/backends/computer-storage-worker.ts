import { DurableObject } from "cloudflare:workers";
import { freeInfrastructurePolicy } from "fortipi-contract";
import { ComputerStore } from "../../src/workspace/computer.js";
import { Mutex } from "../../src/workspace/mutex.js";
import { State } from "../../src/workspace/state.js";

interface Env {
  PROBES: DurableObjectNamespace<ComputerStorageProbe>;
}

async function digest(stream: ReadableStream<Uint8Array>): Promise<string> {
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  const result = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(result)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Actual production owner/storage adapter; no SQL access to Computer private tables. */
export class ComputerStorageProbe extends DurableObject<Env> {
  override async fetch(): Promise<Response> {
    const state = new State(this.ctx.storage);
    const owner = new ComputerStore(state, new Mutex(), freeInfrastructurePolicy);
    let workspace = owner.workspace();
    try {
      await workspace.fs.mkdir("/workspace", { recursive: true });
      const original = Uint8Array.from({ length: 1_100_013 }, (_, i) => (i * 17 + 3) % 251);
      const replacement = Uint8Array.from(original, (b) => (b + 1) % 251);
      await workspace.fs.writeFile("/workspace/data", original);
      await workspace.fs.writeFile("/workspace/empty", new Uint8Array());
      const oldReader = (await workspace.fs.readFile("/workspace/data")).getReader();
      const first = await oldReader.read();
      if (first.done) throw new Error("Nonempty canary returned no first chunk");
      await workspace.fs.writeFile("/workspace/data", replacement);
      const oldDigest = await digest(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(first.value);
          },
          async pull(controller) {
            const next = await oldReader.read();
            if (next.done) {
              oldReader.releaseLock();
              controller.close();
            } else controller.enqueue(next.value);
          },
          async cancel() {
            await oldReader.cancel();
            oldReader.releaseLock();
          },
        }),
      );
      let pulls = 0;
      let writeRejected = false;
      try {
        await workspace.fs.writeFile(
          "/workspace/data",
          new ReadableStream<Uint8Array>(
            {
              pull(controller) {
                if (pulls++ === 0) controller.enqueue(original.slice(0, 524_288));
                else controller.error(new Error("Controlled source failure after staged bytes"));
              },
            },
            { highWaterMark: 0 },
          ),
        );
      } catch {
        writeRejected = true;
      }
      const afterFailure = await digest(await workspace.fs.readFile("/workspace/data"));
      const cancelled = (await workspace.fs.readFile("/workspace/data")).getReader();
      await cancelled.read();
      await cancelled.cancel();
      cancelled.releaseLock();
      // A complete close precedes a new handle on the same real SQLite store.
      await owner.quiesce();
      workspace = owner.workspace();
      const reopened = await digest(await workspace.fs.readFile("/workspace/data"));
      const emptyBytes = (
        await new Response(await workspace.fs.readFile("/workspace/empty")).arrayBuffer()
      ).byteLength;
      return Response.json({
        firstChunkBytes: first.value.length,
        originalBytes: original.length,
        oldDigest,
        writeRejected,
        sourcePulls: pulls,
        afterFailure,
        reopened,
        emptyBytes,
        physicalBytes: state.bytes,
      });
    } finally {
      await owner.quiesce();
    }
  }
}

export default {
  fetch(_request: Request, env: Env): Promise<Response> {
    return env.PROBES.getByName("streaming-storage").fetch("https://probe.internal/");
  },
};
