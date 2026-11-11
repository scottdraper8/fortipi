import type { ClientCommand } from "fortipi-contract";
import { checkAbort, FortiPiError } from "./errors.js";
import type { Http } from "./http.js";
import type { SocketEvent, SocketLike } from "./types.js";
import type { ServerFrame } from "./validation.js";

export interface StreamConnection {
  close(): void;
  done: Promise<void>;
  send(command: ClientCommand): void;
}
/** One ticket, one native upgrade attempt. The caller obtains a new ticket on every retry. */
export function openStream(
  http: Http,
  ticket: string,
  signal: AbortSignal,
  onFrame: (frame: ServerFrame) => Promise<void>,
  onOpen: () => ClientCommand,
): StreamConnection {
  checkAbort(signal);
  const url = new URL("/v1/stream", http.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("ticket", ticket);
  let socket: SocketLike;
  try {
    socket = http.options.webSocket
      ? http.options.webSocket(url.href)
      : (new WebSocket(url.href) as unknown as SocketLike);
  } catch {
    throw new FortiPiError("handshake_failed", { retryable: true });
  }
  const limits = http.protocol?.limits;
  let queued = 0,
    bytes = 0,
    settled = false;
  let chain = Promise.resolve();
  let subscribeRequestId = "";
  let complete: () => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const done = new Promise<void>((resolve, fail) => {
    complete = resolve;
    reject = fail;
  });
  // A caller may attach after synchronous test/socket callbacks.
  void done.catch(() => {});
  let handshake = setTimeout(
    () => finish(new FortiPiError("handshake_timeout", { retryable: true })),
    http.options.timeoutMs ?? 30000,
  );
  const send = (command: ClientCommand) => {
    http.validation.assert("ClientCommand", command);
    if (socket.readyState !== 1) throw new FortiPiError("offline", { retryable: true });
    socket.send(JSON.stringify(command));
  };
  const listeners: Record<string, (event: SocketEvent) => void> = {
    open: () => {
      clearTimeout(handshake);
      try {
        const command = onOpen();
        subscribeRequestId = command.requestId;
        send(command);
        handshake = setTimeout(
          () => finish(new FortiPiError("subscribe_timeout", { retryable: true })),
          http.options.timeoutMs ?? 30000,
        );
      } catch (error) {
        finish(error);
      }
    },
    message: (event) => {
      const data = event.data;
      const size =
        typeof data === "string"
          ? new TextEncoder().encode(data).length
          : data instanceof Blob
            ? data.size
            : data instanceof ArrayBuffer
              ? data.byteLength
              : -1;
      if (size < 0 || size > (limits?.jsonBytes ?? 1048576)) {
        finish(new FortiPiError("invalid_wire"));
        return;
      }
      queued++;
      bytes += size;
      if (
        queued > (limits?.socketBufferFrames ?? 256) ||
        bytes > (limits?.socketBufferBytes ?? 1048576)
      ) {
        finish(new FortiPiError("stream_overflow", { retryable: true }));
        return;
      }
      chain = chain
        .then(async () => {
          if (settled) return;
          let text: string;
          try {
            text =
              typeof data === "string"
                ? data
                : new TextDecoder("utf-8", { fatal: true }).decode(
                    data instanceof Blob ? await data.arrayBuffer() : (data as ArrayBuffer),
                  );
          } catch {
            throw new FortiPiError("invalid_wire");
          }
          if (settled || signal.aborted) return;
          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch {
            throw new FortiPiError("invalid_wire");
          }
          const frame = http.validation.frame(parsed);
          if (
            !("durability" in frame) &&
            ((frame.type === "ack" &&
              frame.operationId === "replayEvents" &&
              frame.requestId === subscribeRequestId) ||
              frame.type === "error" ||
              frame.type === "resync_required")
          )
            clearTimeout(handshake);
          if (
            "durability" in frame &&
            frame.durability === "volatile" &&
            (frame.type === "tool.execution.output" || frame.type === "message.delta") &&
            size > (limits?.outputFrameBytes ?? 16384)
          )
            throw new FortiPiError("payload_too_large");
          await onFrame(frame);
        })
        .then(
          () => {
            queued--;
            bytes -= size;
          },
          (error) => {
            queued--;
            bytes -= size;
            finish(error);
          },
        );
    },
    close: (event) => {
      if (event.code === 1008 || event.code === 1007 || event.code === 1009) {
        finish(
          new FortiPiError(
            event.code === 1008
              ? "unauthorized"
              : event.code === 1007
                ? "invalid_wire"
                : "payload_too_large",
          ),
        );
        return;
      }
      void chain.then(() =>
        finish(
          event.code === 1008
            ? new FortiPiError("unauthorized")
            : new FortiPiError("disconnected", { retryable: true }),
        ),
      );
    },
    error: () => {
      finish(new FortiPiError("handshake_failed", { retryable: true }));
    },
  };
  const abort = () => finish();
  function finish(error?: unknown): void {
    if (settled) return;
    settled = true;
    clearTimeout(handshake);
    signal.removeEventListener("abort", abort);
    for (const [type, listener] of Object.entries(listeners))
      socket.removeEventListener(type, listener);
    try {
      socket.close(1000);
    } catch {
      /* Native transports can already be closed. */
    }
    if (error) reject(error);
    else complete();
  }
  for (const [type, listener] of Object.entries(listeners)) socket.addEventListener(type, listener);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) finish();
  return { close: () => finish(), done, send };
}

/** Low-level generated upgrade operations. The caller owns frame decoding and the returned socket. */
export async function openUpgrade(
  http: Http,
  operationId: import("./types.js").UpgradeOperation,
  ticket: string,
  signal?: AbortSignal,
): Promise<import("./types.js").UpgradeConnection> {
  await http.negotiate(signal);
  const url = new URL(
    operationId === "getClientStream" ? "/v1/stream" : "/v1/executor/session",
    http.origin,
  );
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("ticket", ticket);
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new FortiPiError("aborted"));
      return;
    }
    let socket: SocketLike;
    try {
      socket = http.options.webSocket
        ? http.options.webSocket(url.href)
        : (new WebSocket(url.href) as unknown as SocketLike);
    } catch {
      reject(new FortiPiError("handshake_failed", { retryable: true }));
      return;
    }
    let opened = false,
      closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      cleanup();
      try {
        socket.close(1000);
      } catch {}
    };
    const abort = () => {
      close();
      reject(new FortiPiError("aborted"));
    };
    const failed = () => {
      close();
      if (!opened) reject(new FortiPiError("handshake_failed", { retryable: true }));
    };
    const timer = setTimeout(failed, http.options.timeoutMs ?? 30000);
    const open = () => {
      opened = true;
      clearTimeout(timer);
      resolve({ socket, close });
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      socket.removeEventListener("open", open);
      socket.removeEventListener("error", failed);
      socket.removeEventListener("close", failed);
    };
    socket.addEventListener("open", open);
    socket.addEventListener("error", failed);
    socket.addEventListener("close", failed);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
