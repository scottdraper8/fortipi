import type { SocketEvent, SocketLike } from "../../src/types.ts";

/** Controllable transport for ordering/fault tests; omits TLS, server authorization and persistence. */
export class FixtureSocket implements SocketLike {
  readyState = 0;
  readonly sent: unknown[] = [];
  readonly listeners = new Map<string, Set<(event: SocketEvent) => void>>();
  onSend: ((value: unknown) => void) | undefined;
  constructor() {
    setTimeout(() => {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this.emit("open", {});
    }, 0);
  }
  addEventListener(type: string, listener: (event: SocketEvent) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, listener: (event: SocketEvent) => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  emit(type: string, event: SocketEvent): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  frame(value: unknown): void {
    this.emit("message", { data: JSON.stringify(value) });
  }
  send(data: string): void {
    const value: unknown = JSON.parse(data);
    this.sent.push(value);
    this.onSend?.(value);
  }
  close(code = 1000): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close", { code });
  }
}
