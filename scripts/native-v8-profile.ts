// Private fixture experiment. Raw V8 logs contain full source; never upload them.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, mkdtemp, open, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const MiB = 1024 * 1024;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
export const nativeProfileSource = "apps/worker/test/agent/process-recovery.test.ts";
export function nativeProfileSelected(source: string | null, harness: number, invocation: number) {
  return (
    process.env.FORTIPI_PRIVATE_NATIVE_V8_PROFILE === "1" &&
    source === nativeProfileSource &&
    harness === 2 &&
    invocation === 5
  );
}

function check(ok: unknown): asserts ok {
  if (!ok) throw new Error("private-native-profile-unavailable");
}
const integer = (n: unknown, max: number): n is number =>
  Number.isSafeInteger(n) && (n as number) >= 0 && (n as number) <= max;

async function decode(path: string) {
  return new Promise<{ ok: boolean; stdout: string; stderr: string }>((accept) => {
    execFile(
      process.execPath,
      ["--prof-process", "--preprocess", path],
      {
        timeout: 15000,
        killSignal: "SIGKILL",
        maxBuffer: 32 * MiB,
        env: { PATH: process.env.PATH },
      },
      (error, stdout, stderr) => accept({ ok: !error, stdout, stderr }),
    );
  });
}

/** No native-library symbol subprocesses or full script sources reach the decoder. */
export function filterNativeV8(text: string) {
  check(Buffer.byteLength(text) <= 32 * MiB);
  let strippedLibraries = 0,
    strippedSources = 0;
  const kept = text.split("\n").filter((line) => {
    if (line.startsWith("shared-library,")) {
      strippedLibraries++;
      return false;
    }
    if (line.startsWith("script-source,")) {
      strippedSources++;
      return false;
    }
    return true;
  });
  return { text: kept.join("\n"), strippedLibraries, strippedSources };
}

/** Closed projection only. Never return any input objects, scripts or names. */
export function sanitizeNativeV8(text: string, rawTicks: number) {
  check(Buffer.byteLength(text) <= 32 * MiB && integer(rawTicks, 200000));
  const warning = "Testing v8 version different from logging version\n";
  const versionMismatch = text.startsWith(warning);
  const json = versionMismatch ? text.slice(warning.length) : text;
  check(json.startsWith("{"));
  const p = JSON.parse(json) as {
    code: { type?: unknown; name?: unknown }[];
    ticks: { s?: unknown }[];
  };
  check(p && Array.isArray(p.code) && p.code.length <= 100000 && Array.isArray(p.ticks));
  check(p.ticks.length <= 200000 && p.ticks.length <= rawTicks);
  const counts = new Map<number, number>();
  for (const tick of p.ticks) {
    check(tick && Array.isArray(tick.s) && tick.s.length <= 4096 && tick.s.length % 2 === 0);
    const id: unknown = tick.s[0];
    if (integer(id, p.code.length - 1)) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  let jsSelfTicks = 0;
  const frames = new Map<
    string,
    {
      functionSHA256: string;
      file: "worker.js" | "runtime-worker.js" | "runtime-worker.ts" | null;
      urlSHA256: string;
      line: number;
      column: number;
      selfTicks: number;
    }
  >();
  for (const [id, selfTicks] of counts) {
    const code = p.code[id];
    if (code?.type !== "JS") continue;
    jsSelfTicks += selfTicks;
    check(typeof code.name === "string" && code.name.length <= 8192);
    const match = /^(.*?) (.+):(\d+):(\d+)$/.exec(code.name);
    if (!match) continue;
    const line = Number(match[3]),
      column = Number(match[4]);
    check(integer(line, 10000000) && integer(column, 10000000));
    const url = match[2] ?? "";
    const file = /(?:^|\/)runtime-worker\.js$/.test(url)
      ? ("runtime-worker.js" as const)
      : /(?:^|\/)runtime-worker\.ts$/.test(url)
        ? ("runtime-worker.ts" as const)
        : url === "worker.js"
          ? ("worker.js" as const)
          : null;
    const frame = {
      functionSHA256: sha(match[1] ?? ""),
      file,
      urlSHA256: sha(url),
      line,
      column,
      selfTicks,
    };
    const key = JSON.stringify([frame.functionSHA256, frame.urlSHA256, line, column]);
    const previous = frames.get(key);
    if (previous) previous.selfTicks += selfTicks;
    else frames.set(key, frame);
  }
  const ranked = [...frames.values()].sort(
    (a, b) =>
      b.selfTicks - a.selfTicks ||
      a.functionSHA256.localeCompare(b.functionSHA256) ||
      a.urlSHA256.localeCompare(b.urlSHA256),
  );
  return {
    decodedTicks: p.ticks.length,
    versionMismatch,
    jsSelfTicks,
    otherSelfTicks: p.ticks.length - jsSelfTicks,
    frames: ranked.slice(0, 10),
  };
}

async function boundedFile(path: string, max: number) {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await fd.stat();
    check(stat.isFile() && stat.size > 0 && stat.size <= max);
    await fd.chmod(0o600);
    const bytes = Buffer.alloc(stat.size);
    let used = 0;
    while (used < bytes.length) {
      const part = await fd.read(bytes, used, bytes.length - used, used);
      check(part.bytesRead > 0);
      used += part.bytesRead;
    }
    const end = await fd.stat();
    check(end.size >= stat.size);
    return { bytes, complete: end.size === stat.size && bytes.at(-1) === 10 };
  } finally {
    await fd.close();
  }
}

/** Private raw snapshots, only from the unique directory given to the owned graph. */
export async function nativeV8Logs(directory: string, owner?: number) {
  const names = await readdir(directory);
  check(names.length > 0 && names.length <= 32);
  const logs = [];
  let bytes = 0;
  for (const name of names) {
    const match = /^isolate-[A-Za-z0-9x-]+-(\d+)-profile\.log$/.exec(name);
    check(match && (owner === undefined || Number(match[1]) === owner));
    const snapshot = await boundedFile(join(directory, name), Math.min(32 * MiB, 64 * MiB - bytes));
    bytes += snapshot.bytes.length;
    check(bytes <= 64 * MiB);
    const raw = snapshot.bytes.subarray(0, snapshot.bytes.lastIndexOf(10) + 1);
    const ticks = raw
      .toString()
      .split("\n")
      .filter((line: string) => line.startsWith("tick,")).length;
    check(ticks <= 200000);
    logs.push({ name, raw, ticks, readBytes: snapshot.bytes.length, complete: snapshot.complete });
  }
  return logs;
}

/** Unique directory is supplied only to this owned child graph, not an isolate identity. */
export async function beginNativeV8Profile() {
  const directory = await mkdtemp(join(tmpdir(), "fortipi-private-v8-"));
  try {
    await chmod(directory, 0o700);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    flags: `--prof --logfile=${join(directory, "profile.log")}`,
    directory,
    async collect(
      snapshot: "startup-failure-after-close" | "post-ready-after-close" | "control-after-kill",
      control = false,
    ) {
      const selected = [];
      let files = 0,
        rawBytes = 0,
        stage = "files",
        decodeFailures = 0,
        schemaFailures = 0,
        noSamples = 0;
      try {
        const logs = await nativeV8Logs(directory);
        files = logs.length;
        rawBytes = logs.reduce((sum, log) => sum + log.readBytes, 0);
        logs.sort((a, b) => b.ticks - a.ticks || a.name.localeCompare(b.name));
        for (const log of logs.slice(0, 2)) {
          if (!log.ticks) {
            noSamples++;
            continue;
          }
          stage = "decode";
          // Decode the exact bounded snapshot, never the potentially growing original.
          const path = join(directory, "selected.log");
          const filtered = filterNativeV8(log.raw.toString());
          await writeFile(path, filtered.text, { mode: 0o600 });
          const decoded = await decode(path);
          // Raw streams are retained privately and never passed to errors/loggers.
          await writeFile(join(directory, "decoder.stdout"), decoded.stdout, { mode: 0o600 });
          await writeFile(join(directory, "decoder.stderr"), decoded.stderr, { mode: 0o600 });
          if (!decoded.ok) {
            decodeFailures++;
            continue;
          }
          try {
            const clean = sanitizeNativeV8(decoded.stdout, log.ticks);
            if (!clean.decodedTicks) {
              noSamples++;
              continue;
            }
            selected.push({
              rank: logs.indexOf(log) + 1,
              rawBytes: log.readBytes,
              completeBytes: log.raw.length,
              rawTicks: log.ticks,
              complete: log.complete,
              stderrBytes: Buffer.byteLength(decoded.stderr),
              strippedLibraries: filtered.strippedLibraries,
              strippedSources: filtered.strippedSources,
              filteredBytes: Buffer.byteLength(filtered.text),
              ...clean,
            });
          } catch {
            schemaFailures++;
          }
        }
        stage = schemaFailures
          ? "schema"
          : decodeFailures
            ? "decode"
            : noSamples
              ? "no-samples"
              : "complete";
      } catch {
        /* Never emit raw errors, log data or paths. */
      } finally {
        await rm(directory, { recursive: true, force: true }).catch(() => {});
      }
      const record = {
        kind: "private-native-v8",
        snapshot,
        selection: "largest-tick-owned-directory",
        sourcePath: control ? null : nativeProfileSource,
        harnessOrdinal: control ? null : 2,
        invocation: control ? null : 5,
        status: !selected.length
          ? "unavailable"
          : !decodeFailures &&
              !schemaFailures &&
              !noSamples &&
              selected.every((log) => log.complete && log.decodedTicks === log.rawTicks)
            ? "available"
            : "partial",
        stage,
        files,
        rawBytes,
        decodeFailures,
        schemaFailures,
        noSamples,
        selected,
      };
      const text = `${JSON.stringify(record)}\n`;
      check(Buffer.byteLength(text) <= 16384);
      const destination = resolve(".agent-docs/tmp/native-v8-profile");
      await mkdir(destination, { recursive: true, mode: 0o700 });
      await writeFile(join(destination, control ? "control.json" : "recovery.json"), text, {
        mode: 0o600,
      });
      return record;
    },
  };
}
