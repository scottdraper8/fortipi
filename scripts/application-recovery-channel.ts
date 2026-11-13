import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import type {
  ApplicationRecoveryBridge,
  ExistingApplicationRecoveryBridge,
} from "../tests/clients/platform-recovery.ts";
import { type FileRecord, object, string } from "./verify-release-gates.ts";

const protocol = "fortipi-application-recovery-v1";
type Coordinator =
  | { mode: "perform"; bridge: ApplicationRecoveryBridge }
  | { mode: "verify-existing"; bridge: ExistingApplicationRecoveryBridge };
type Method = "perform" | "finish" | "verifyExisting";
type Reply = {
  perform: Awaited<ReturnType<ApplicationRecoveryBridge["perform"]>>;
  finish: Awaited<ReturnType<ApplicationRecoveryBridge["finish"]>>;
  verifyExisting: Awaited<ReturnType<ExistingApplicationRecoveryBridge["verifyExisting"]>>;
};
const methods = (mode: Coordinator["mode"]): Method[] =>
  mode === "perform" ? ["perform", "finish"] : ["verifyExisting"];
function closed(value: unknown, keys: string[]) {
  const result = object(value);
  assert.deepEqual(Object.keys(result).sort(), [...keys].sort());
  return result;
}
function checkpoint(value: unknown, directory: string, method: Method): FileRecord {
  const row = closed(value, ["path", "size", "mode", "sha256"]);
  assert.equal(
    row.path,
    resolve(directory, `application-${method === "perform" ? "before" : "after"}.json`),
  );
  assert.ok(
    Number.isSafeInteger(row.size) && Number(row.size) > 0 && Number(row.size) <= 1_000_000,
  );
  assert.ok(Number.isSafeInteger(row.mode) && [0o400, 0o600].includes(Number(row.mode)));
  assert.match(string(row.sha256), /^[a-f0-9]{64}$/);
  return Object.freeze({
    path: string(row.path),
    size: Number(row.size),
    mode: Number(row.mode),
    sha256: string(row.sha256),
  });
}
function safeMessage(value: unknown, forbidden: readonly string[] = []): string {
  const bytes = JSON.stringify(value);
  assert.ok(Buffer.byteLength(bytes) <= 1_000_000, "Recovery channel byte bound");
  for (const secret of forbidden)
    if (secret) {
      const escaped = JSON.stringify(secret).slice(1, -1);
      assert.ok(
        !bytes.includes(secret) && !bytes.includes(escaped),
        "Credential forbidden in recovery response",
      );
    }
  return bytes;
}

/** Dedicated inherited Node IPC only. The trusted bridge must authenticate the
 * checkpoint bytes/provider lineage; transport data never grants that authority. */
export function attachApplicationRecoveryChannel(
  child: ChildProcess,
  directory: string,
  coordinator: Coordinator,
  forbidden: readonly string[] = [],
) {
  assert.ok(isAbsolute(directory) && child.connected && child.send);
  let accepted = 0;
  let completed = 0;
  let failure: Error | undefined;
  let pending = Promise.resolve();
  const send = (value: Record<string, unknown>) => {
    safeMessage(value, forbidden);
    if (child.connected) child.send?.(value, () => {});
  };
  const reject = (id: unknown) => {
    failure ??= new Error("Application recovery channel rejected");
    send({ protocol, id: Number.isSafeInteger(id) ? id : 0, ok: false });
  };
  const onMessage = (value: unknown) => {
    let id: unknown = 0;
    try {
      safeMessage(value);
      const request = closed(value, ["protocol", "id", "method", "checkpoint"]);
      id = request.id;
      assert.equal(request.protocol, protocol);
      assert.equal(request.id, accepted + 1);
      assert.equal(accepted, completed, "Prior recovery phase still pending");
      assert.ok(!failure);
      const method = methods(coordinator.mode)[accepted];
      assert.ok(method && request.method === method, "Recovery phase mismatch");
      let file: FileRecord | undefined;
      if (method === "verifyExisting") assert.equal(request.checkpoint, null);
      else file = checkpoint(request.checkpoint, directory, method);
      accepted++;
      pending = pending.then(async () => {
        if (failure) return;
        try {
          let result: unknown;
          if (coordinator.mode === "verify-existing")
            result = await coordinator.bridge.verifyExisting();
          else {
            assert.ok(file);
            result =
              method === "perform"
                ? await coordinator.bridge.perform(file)
                : await coordinator.bridge.finish(file);
          }
          send({ protocol, id, ok: true, value: result });
          completed++;
        } catch {
          reject(id);
        }
      });
    } catch {
      reject(id);
    }
  };
  child.on("message", onMessage);
  return {
    async settled() {
      await pending;
      if (failure) throw failure;
      assert.equal(completed, methods(coordinator.mode).length, "Application recovery incomplete");
    },
    close() {
      child.off("message", onMessage);
    },
  };
}

export function applicationRecoveryChannel(mode: "perform"): ApplicationRecoveryBridge;
export function applicationRecoveryChannel(
  mode: "verify-existing",
): ExistingApplicationRecoveryBridge;
export function applicationRecoveryChannel(mode: Coordinator["mode"]) {
  assert.ok(process.send && process.connected, "Inherited application recovery channel required");
  let sequence = 0;
  let busy = false;
  let failed = false;
  const call = async <M extends Method>(method: M, file: FileRecord | null): Promise<Reply[M]> => {
    assert.ok(!failed && !busy && methods(mode)[sequence] === method, "Recovery phase mismatch");
    busy = true;
    const id = ++sequence;
    try {
      const request = { protocol, id, method, checkpoint: file };
      safeMessage(request);
      return await new Promise<Reply[M]>((accept, reject) => {
        const finish = (error?: Error, value?: Reply[M]) => {
          clearTimeout(timer);
          process.off("message", message);
          process.off("disconnect", disconnected);
          if (error) reject(error);
          else {
            assert.ok(value);
            accept(value);
          }
        };
        const disconnected = () => finish(new Error("Application recovery channel unavailable"));
        const message = (value: unknown) => {
          try {
            safeMessage(value);
            const response = object(value);
            assert.equal(response.protocol, protocol);
            assert.equal(response.id, id);
            assert.equal(typeof response.ok, "boolean");
            closed(
              response,
              response.ok ? ["protocol", "id", "ok", "value"] : ["protocol", "id", "ok"],
            );
            if (!response.ok) throw new Error("Application recovery unavailable");
            const result = object(response.value);
            const status =
              method === "perform"
                ? "operation-confirmed"
                : method === "finish"
                  ? "qualified"
                  : "lineage-confirmed";
            assert.ok(result.status === status || result.status === "unavailable");
            // Domain wrappers verify the actual identities/checkpoints. This is
            // only the typed reply from the prebound trusted process, not proof.
            finish(undefined, result as Reply[M]);
          } catch {
            finish(new Error("Application recovery response rejected"));
          }
        };
        const timer = setTimeout(disconnected, 300_000);
        process.on("message", message);
        process.once("disconnect", disconnected);
        process.send?.(request, (error) => {
          if (error) disconnected();
        });
      });
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      busy = false;
    }
  };
  return mode === "perform"
    ? {
        perform: (file: FileRecord) => call("perform", file),
        finish: (file: FileRecord) => call("finish", file),
      }
    : { verifyExisting: () => call("verifyExisting", null) };
}
