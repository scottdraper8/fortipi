import { Socket } from "node:net";
import type { Controller } from "./controller.js";

export type Observation = ((controller: Controller, focus: string) => void) & { close(): void };
/** A dedicated inherited pipe/socket. Slow or absent observers cannot block input or process exit. */
export function observer(fd: number | undefined): Observation {
  let socket: Socket | undefined;
  let ready = true,
    last = "";
  if (fd !== undefined && Number.isSafeInteger(fd) && fd >= 3) {
    try {
      socket = new Socket({ fd, readable: false, writable: true });
      socket.unref();
      socket.on("error", () => {
        socket?.destroy();
        socket = undefined;
      });
      socket.on("drain", () => {
        ready = true;
      });
      socket.on("close", () => {
        socket = undefined;
      });
    } catch {
      socket = undefined;
    }
  }
  const emit = (controller: Controller, focus: string) => {
    if (!socket || !ready) return;
    const value = JSON.stringify({
      schemaVersion: 1,
      view: controller.view,
      focus,
      connection: controller.connection,
      conversationId: controller.conversationId,
      cursor: controller.projection.cursor,
      appliedIds: controller.projection.appliedIds.slice(-16),
    });
    if (value === last || Buffer.byteLength(value) > 8192) return;
    last = value;
    ready = socket.write(`${value}\n`);
  };
  return Object.assign(emit, {
    close() {
      socket?.destroy();
      socket = undefined;
    },
  });
}
