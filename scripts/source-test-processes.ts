import { ChildProcess } from "node:child_process";
import { subscribe } from "node:diagnostics_channel";
import { availableParallelism } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const testPath =
  /^(?:packages\/fortipi-[a-z]+\/test|apps\/worker\/test|scripts\/test\/release|tests\/clients)\/[A-Za-z0-9._/-]+\.(?:test|spec)\.ts$/;
const selected = new Map<string, string>();
for (const argument of process.argv.slice(1)) {
  const path = relative(root, argument).replaceAll("\\", "/");
  if (testPath.test(path) && !path.split("/").includes("..")) selected.set(resolve(argument), path);
}

// Only the test driver observes its own direct children. Never print argv,
// environment, child output, arbitrary paths or library error descriptions.
if (process.execArgv.includes("--test") && selected.size > 0 && selected.size <= 512) {
  const began = performance.now();
  let active = 0;
  const emit = (record: Record<string, string | number | null>) =>
    process.stderr.write(`${JSON.stringify(record)}\n`);
  emit({
    diagnostic: "source-test-host",
    node: process.versions.node,
    availableParallelism: availableParallelism(),
    files: selected.size,
  });
  subscribe("child_process", (message: unknown) => {
    if (message === null || typeof message !== "object") return;
    const child = (message as { process?: ChildProcess }).process;
    if (!(child instanceof ChildProcess)) return;
    child.once("spawn", () => {
      const matches = child.spawnargs.flatMap((argument) => {
        const path = selected.get(resolve(argument));
        return path === undefined ? [] : [path];
      });
      if (matches.length !== 1) return;
      const path = matches[0];
      if (path === undefined) return;
      active++;
      emit({
        diagnostic: "source-test-process",
        event: "spawn",
        path,
        elapsedMs: Math.round(performance.now() - began),
        active,
        code: null,
        signal: null,
      });
      child.once("exit", (code, signal) => {
        active--;
        emit({
          diagnostic: "source-test-process",
          event: "exit",
          path,
          elapsedMs: Math.round(performance.now() - began),
          active,
          code: Number.isInteger(code) && code !== null && Math.abs(code) <= 255 ? code : null,
          signal: signal === null || /^SIG[A-Z0-9]{1,8}$/.test(signal) ? signal : "other",
        });
      });
    });
  });
}

/** Accept only the fixed nonsecret records emitted above, never raw stderr. */
export function sourceTestDiagnostic(line: string): boolean {
  if (line.length > 512) return false;
  return (
    /^\{"diagnostic":"source-test-host","node":"\d{1,3}\.\d{1,3}\.\d{1,3}","availableParallelism":\d{1,4},"files":\d{1,3}\}$/.test(
      line,
    ) ||
    (/^\{"diagnostic":"source-test-process","event":"(?:spawn|exit)","path":"(?:packages\/fortipi-[a-z]+\/test|apps\/worker\/test|scripts\/test\/release|tests\/clients)\/[A-Za-z0-9._/-]+\.(?:test|spec)\.ts","elapsedMs":\d{1,8},"active":\d{1,3},"code":(?:null|-?\d{1,3}),"signal":(?:null|"(?:SIG[A-Z0-9]{1,8}|other)")\}$/.test(
      line,
    ) &&
      !line.includes("../")) ||
    recoveryDiagnostic(line)
  );
}

/** Exact process-recovery fixture output only, never an arbitrary TAP diagnostic. */
function recoveryDiagnostic(line: string): boolean {
  if (!line.startsWith("# ")) return false;
  let value: unknown;
  try {
    value = JSON.parse(line.slice(2));
  } catch {
    return false;
  }
  const closed = (input: unknown, keys: string): input is Record<string, unknown> =>
    input !== null &&
    typeof input === "object" &&
    !Array.isArray(input) &&
    Object.keys(input).join(",") === keys;
  // Echo original bytes only when they are exactly the producer's serialization.
  // Otherwise duplicate keys could conceal a private value discarded by JSON.parse.
  if (!closed(value, "phase,kind,code,location,request") || line !== `# ${JSON.stringify(value)}`)
    return false;
  const code = (input: unknown, allowed: string[]) =>
    input === null || (typeof input === "string" && allowed.includes(input));
  if (
    typeof value.phase !== "string" ||
    !/^(?:initial\.start|agent\.create|canary\.(?:write|crash|restart|read)|allocation\.(?:initial|arm|wait|crash|restart|retry)|(?:before-submit|after-submit)\.(?:arm|wait|crash|restart|retry|complete|inspect|repeat)|cleanup)$/.test(
      value.phase,
    ) ||
    typeof value.kind !== "string" ||
    !["unknown", "assertion", "error", "non-error"].includes(value.kind) ||
    !code(value.code, [
      "ERR_ASSERTION",
      "ECONNRESET",
      "ECONNREFUSED",
      "ETIMEDOUT",
      "ABORT_ERR",
      "ERR_TEST_FAILURE",
    ]) ||
    (value.location !== null &&
      (typeof value.location !== "string" ||
        !/^(?:process-(?:recovery\.test|harness)|harness)\.ts:\d{1,6}:\d{1,6}$/.test(
          value.location,
        )))
  )
    return false;
  const request = value.request;
  return (
    request === null ||
    (closed(request, "operation,stage,reason,code,childExitCode,childSignal") &&
      typeof request.operation === "string" &&
      ["state", "barrier", "submission", "other"].includes(request.operation) &&
      typeof request.stage === "string" &&
      ["response", "body"].includes(request.stage) &&
      typeof request.reason === "string" &&
      ["deadline", "transport", "body"].includes(request.reason) &&
      code(request.code, [
        "ECONNRESET",
        "ECONNREFUSED",
        "ETIMEDOUT",
        "UND_ERR_SOCKET",
        "UND_ERR_CONNECT_TIMEOUT",
        "UND_ERR_HEADERS_TIMEOUT",
        "UND_ERR_BODY_TIMEOUT",
      ]) &&
      (request.childExitCode === null ||
        (typeof request.childExitCode === "number" &&
          Number.isInteger(request.childExitCode) &&
          Math.abs(request.childExitCode) <= 255)) &&
      (request.childSignal === null ||
        request.childSignal === "SIGKILL" ||
        request.childSignal === "SIGTERM"))
  );
}
