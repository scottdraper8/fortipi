// Ordinary owned Node processes only. No ports, product runtime, credentials or provider.
import { spawn } from "node:child_process";
import process from "node:process";

const mode = process.argv[2];
if (mode === "early-exit") {
  const descendant = spawn(process.execPath, [import.meta.filename, "held-pipes"], {
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  descendant.once("message", () => process.exit(17));
} else if (mode === "held-pipes" || mode === "held-command" || mode === "slow-drain") {
  process.stdout.write("owned-stdout-ready\n");
  process.stderr.write("owned-stderr-ready\n");
  process.send?.({ ready: true });
  // Self-expiry bounds this fixture if its test parent disappears.
  const expiry = setTimeout(() => process.exit(0), 10000);
  process.on("SIGTERM", () => {
    clearTimeout(expiry);
    const drain = () => {
      process.stdout.write("owned-stdout-drained\n");
      process.stderr.write("owned-stderr-drained\n");
      if (process.connected) process.disconnect?.();
    };
    if (mode === "slow-drain") setTimeout(drain, 6000);
    else drain();
  });
} else throw new Error("Unknown owned Node fixture mode");
