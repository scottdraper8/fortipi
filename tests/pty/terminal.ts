import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import headless from "@xterm/headless";
import { spawn } from "node-pty";

const { Terminal } = headless;

/** Actual OS PTY/ConPTY and current screen cells. Never match stale raw bytes. */
export function terminal(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const screen = new Terminal({ cols: 110, rows: 32, allowProposedApi: true });
  const child = spawn(command, args, { cwd, env, name: "xterm-256color", cols: 110, rows: 32 });
  let pending = Promise.resolve();
  let exited = false;
  let disposed = false;
  const disposeScreen = () => {
    if (!disposed) {
      screen.dispose();
      disposed = true;
    }
  };
  const ended = new Promise<{ exitCode: number; signal?: number }>((accept) =>
    child.onExit((value) => {
      exited = true;
      accept(value);
    }),
  );
  child.onData((bytes) => {
    pending = pending.then(() => new Promise<void>((accept) => screen.write(bytes, accept)));
  });
  const text = () =>
    Array.from(
      { length: screen.rows },
      (_, i) =>
        screen.buffer.active.getLine(screen.buffer.active.viewportY + i)?.translateToString(true) ??
        "",
    ).join("\n");
  return {
    write(keys: string) {
      assert.ok(!exited, "Installed terminal exited before its key action");
      child.write(keys);
    },
    resize(cols: number, rows: number) {
      child.resize(cols, rows);
      screen.resize(cols, rows);
    },
    async currentScreen() {
      await pending;
      return text();
    },
    async wait(predicate: (currentScreen: string) => boolean, timeout = 20000) {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        await pending;
        if (predicate(text())) return;
        assert.ok(!exited, "Installed TUI exited before its screen oracle");
        await new Promise<void>((accept) => setTimeout(accept, 25));
      }
      throw new Error("Installed TUI current-screen condition timed out");
    },
    async screenDigest() {
      await pending;
      return createHash("sha256").update(text()).digest("hex");
    },
    async exit(timeout = 10000) {
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        if (!exited) child.kill("SIGKILL");
      }, timeout);
      try {
        const status = await ended;
        assert.equal(timedOut, false);
        assert.equal(status.exitCode, 0);
        assert.ok(status.signal === undefined || status.signal === 0);
        return status;
      } finally {
        clearTimeout(timer);
        disposeScreen();
      }
    },
    async dispose() {
      if (!exited) child.kill("SIGKILL");
      await ended;
      await pending;
      disposeScreen();
    },
  };
}
