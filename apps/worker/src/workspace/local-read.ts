import { createHash } from "node:crypto";
import { digestJson } from "fortipi-contract";
import type * as D from "../boundary/dto.js";
import { requireThat, unwrap, WorkspaceError } from "./errors.js";
import { LocalProvider } from "./local.js";
import { boundedBytes, bytesStream } from "./streams.js";
import type { WorkspaceObject } from "./workspace-object.js";

/** One chunk in memory, no canonical byte storage. The peer is waiting before the owner produces. */
export class LocalReads {
  readonly owner: WorkspaceObject;
  private active = 0;
  constructor(owner: WorkspaceObject) {
    this.owner = owner;
  }
  async open(
    ctx: D.AuthContext,
    binding: D.WorkspaceBinding,
    revision: string,
    entry: Extract<D.ManifestEntry, { type: "file" }>,
    manifestHash: string,
    signal: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>> {
    requireThat(
      this.active < Math.min(2, this.owner.policy.bounds.transferConcurrency),
      "quota_paused",
      "Concurrent local read stream bound reached",
    );
    this.active++;
    let finished = false;
    const release = () => {
      if (!finished) {
        finished = true;
        this.active--;
      }
    };
    try {
      // A range-hash pass and its body pass are separate observations, never a replay of a completed producer.
      const readContext = { ...ctx, requestId: crypto.randomUUID() };
      const provider = new LocalProvider(this.owner.control());
      const { request, reference } = await provider.readPlan(
        readContext,
        binding,
        revision,
        entry.path,
      );
      requireThat(
        reference.workspaceId === binding.workspaceId &&
          reference.revision === revision &&
          reference.sha256 === entry.sha256 &&
          reference.size === entry.size &&
          reference.chunks,
        "workspace.conflict",
        "Local read differs from the retained manifest",
        { reason: "local_drift" },
      );
      if (entry.size === 0) {
        release();
        return bytesStream(new Uint8Array());
      }
      const grant = ctx.grants.find(
        (grant) =>
          (!grant.expiresAt || grant.expiresAt > Date.now()) &&
          grant.resources.workspaceIds.includes(binding.workspaceId) &&
          grant.resources.actions.includes("workspace.read"),
      );
      requireThat(grant, "unauthorized", "Local read grant required");
      const inventory = reference.chunks;
      const descriptor = unwrap(
        await this.owner.control().openTransfer(ctx, {
          deploymentId: ctx.deploymentId,
          direction: "from-executor",
          purpose: "local-read",
          workspaceId: binding.workspaceId,
          bindingVersion: binding.bindingVersion,
          operationId: request.operationId,
          operationDigest: await digestJson("operation", {
            kind: "local-read",
            request,
            manifestHash,
            sha256: entry.sha256,
            size: entry.size,
            chunks: inventory,
          }),
          executorId: request.executorId,
          executorGeneration: request.executorGeneration,
          credential: request.credential,
          consumer: grant.resources,
          baseRevision: revision,
          content: { kind: "workspace-file", path: entry.path, manifestHash },
          fileSha256: entry.sha256,
          size: entry.size,
          chunkBytes: inventory.chunkBytes,
          chunkHashes: inventory.chunkHashes,
          expiresAt: Math.min(ctx.deadline, Date.now() + 60_000),
          deadline: ctx.deadline,
        }),
      );
      const abort = new AbortController();
      let cancelBody: (() => Promise<void>) | undefined;
      let fail: ((error: Error) => void) | undefined;
      const close = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
        abort.abort();
        void cancelBody?.();
        release();
      };
      const cancel = () => {
        close();
        fail?.(new WorkspaceError("interrupted", "Local read disconnected or expired"));
      };
      const timer = setTimeout(
        cancel,
        Math.max(1, Math.min(ctx.deadline, descriptor.expiresAt) - Date.now()),
      );
      signal.addEventListener("abort", cancel, { once: true });
      const peer = (index: number): Promise<Response> => {
        const url = new URL(
          `https://control.internal/internal/transfers/${descriptor.transferId}/peer/chunks/${index}`,
        );
        url.searchParams.set("attemptId", descriptor.attemptId);
        url.searchParams.set(
          "length",
          String(Math.min(descriptor.chunkBytes, entry.size - index * descriptor.chunkBytes)),
        );
        url.searchParams.set("sha256", descriptor.chunkHashes[index] ?? "");
        return this.owner.control().fetch(
          new Request(url, {
            headers: { "X-Fortipi-Context": JSON.stringify(ctx) },
            signal: abort.signal,
          }),
        );
      };
      // Attach rejection handlers immediately. Awaiting the producer here deadlocks a matched relay.
      let next = peer(0).then(
        (response) => ({ response }),
        (error: unknown) => ({ error }),
      );
      const producing = provider.produce(ctx, request, [descriptor], reference).then(
        () => true,
        () => {
          cancel();
          return false;
        },
      );
      this.owner.trackLocalRead(producing);
      const hash = createHash("sha256");
      let index = 0;
      let length = 0;
      if (signal.aborted) cancel();
      return new ReadableStream({
        start(controller) {
          fail = (error) => controller.error(error);
        },
        async pull(controller) {
          try {
            requireThat(!finished && !abort.signal.aborted, "interrupted", "Local read closed");
            if (index === descriptor.chunkHashes.length) {
              requireThat(
                length === entry.size && hash.digest("hex") === entry.sha256 && (await producing),
                "workspace.conflict",
                "Local read whole-file verification failed",
                { reason: "local_drift" },
              );
              close();
              controller.close();
              return;
            }
            const delivered = await next;
            requireThat(
              "response" in delivered &&
                delivered.response.status === 200 &&
                delivered.response.body,
              "interrupted",
              "Local read peer delivery incomplete",
            );
            const reader = delivered.response.body.getReader();
            let readerClosed = false;
            const finishReader = async () => {
              if (!readerClosed) {
                readerClosed = true;
                await reader.cancel().catch(() => {});
                reader.releaseLock();
              }
            };
            cancelBody = finishReader;
            const source = new ReadableStream<Uint8Array>({
              async pull(out) {
                const item = await reader.read();
                if (item.done) {
                  await finishReader();
                  out.close();
                } else out.enqueue(item.value);
              },
              async cancel() {
                await finishReader();
              },
            });
            const bytes = await boundedBytes(
              source,
              Math.min(descriptor.chunkBytes, entry.size - length),
              descriptor.chunkHashes[index] ?? "",
              ctx.deadline,
            );
            cancelBody = undefined;
            hash.update(bytes);
            length += bytes.length;
            index++;
            if (index < descriptor.chunkHashes.length)
              next = peer(index).then(
                (response) => ({ response }),
                (error: unknown) => ({ error }),
              );
            controller.enqueue(bytes);
          } catch (error) {
            close();
            controller.error(error);
          }
        },
        async cancel() {
          close();
          await producing;
        },
      });
    } catch (error) {
      release();
      throw error;
    }
  }
}
