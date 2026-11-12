import { CliError, check } from "./errors.js";
import type { CliInteraction } from "./interaction-types.js";

/** OAuth interaction is terminal-only, including in JSON mode. Input is never echoed or retained. */
export function terminalInteraction(signal: AbortSignal): CliInteraction {
  check(process.stdin.isTTY && process.stderr.isTTY, "oauth_interactive_terminal_required", 3);
  const write = (message: string) => process.stderr.write(`${message}\n`);
  return {
    signal,
    notify(event) {
      signal.throwIfAborted();
      switch (event.type) {
        case "auth_url":
          write(`${event.instructions ?? "Open this authorization URL:"}\n${event.url}`);
          break;
        case "device_code":
          write(`Open ${event.verificationUri}\nEnter the displayed code: ${event.userCode}`);
          break;
        case "info":
          write(event.message);
          for (const link of event.links ?? []) write(`${link.label ?? ""} ${link.url}`);
          break;
        case "progress":
          write(event.message);
          break;
      }
    },
    async prompt(prompt) {
      const promptSignal = AbortSignal.any([signal, ...(prompt.signal ? [prompt.signal] : [])]);
      promptSignal.throwIfAborted();
      write(prompt.message);
      if (prompt.type === "select")
        for (const option of prompt.options) write(`${option.id}: ${option.label}`);
      const answer = await new Promise<string>((accept, reject) => {
        let input = "";
        const raw = process.stdin.isRaw;
        process.stdin.setRawMode(true);
        process.stdin.resume();
        const cleanup = () => {
          process.stdin.off("data", data);
          promptSignal.removeEventListener("abort", abort);
          process.stdin.setRawMode(raw);
          process.stdin.pause();
          write("");
        };
        const abort = () => {
          cleanup();
          input = "";
          reject(new CliError("cancelled", 130));
        };
        const data = (bytes: Buffer) => {
          for (const char of bytes.toString("utf8")) {
            if (char === "\u0003" || char === "\u0004") {
              abort();
              return;
            }
            if (char === "\r" || char === "\n") {
              cleanup();
              const result = input;
              input = "";
              accept(result);
              return;
            }
            if (char === "\u007f") input = input.slice(0, -1);
            else if (char >= " ") input += char;
            if (Buffer.byteLength(input) > 16384) {
              abort();
              return;
            }
          }
        };
        process.stdin.on("data", data);
        promptSignal.addEventListener("abort", abort, { once: true });
      });
      check(
        prompt.type !== "select" || prompt.options.some((o) => o.id === answer),
        "invalid_oauth_choice",
      );
      return answer;
    },
  };
}
