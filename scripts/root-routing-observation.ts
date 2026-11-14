// Temporary routing observation. Only a flag-marked probe produces markers.
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";

export const routingHeader = "FORTIPI_ROOT_CONTEXT_DIAGNOSTICS";
export const routingPrefix = "FORTIPI_ROOT_ROUTE_V1 ";
export const routingStages = [
  "proxy-accepted",
  "proxy-config-wait",
  "proxy-config-present",
  "proxy-forward",
  "user-ping-enter",
  "user-ping-return",
  "proxy-upstream-response",
] as const;
type Stage = (typeof routingStages)[number];
type Kind = "process" | "integration";
const integer = (n: unknown, min: number, max: number): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && !Object.is(n, -0) && n >= min && n <= max;

/** Closed records only; raw worker console text never passes this validator. */
export function rootRoutingDiagnostic(line: string): boolean {
  if (typeof line !== "string" || line.length > 512) return false;
  const json = line.startsWith("# ") ? line.slice(2) : line;
  try {
    const r = JSON.parse(json);
    const index = routingStages.indexOf(r?.stage);
    return (
      r !== null &&
      typeof r === "object" &&
      !Array.isArray(r) &&
      Object.keys(r).join(",") === "diagnostic,kind,invocation,stage,mask" &&
      json === JSON.stringify(r) &&
      r.diagnostic === "root-routing-v1" &&
      ["process", "integration"].includes(r.kind) &&
      integer(r.invocation, 1, 999) &&
      index >= 0 &&
      integer(r.mask, 1, 127) &&
      (r.mask & (1 << index)) !== 0
    );
  } catch {
    return false;
  }
}

/** One child/launch, at most seven enums. Arm only for its single marked HTTP probe. */
export function observeRootRouting(
  child: ChildProcess,
  kind: Kind,
  invocation: number,
  emit: (line: string) => void,
) {
  let mask = 0,
    armed = false,
    stopped = false;
  const detach: (() => void)[] = [];
  const stop = () => {
    if (stopped) return;
    stopped = true;
    for (const off of detach.splice(0)) {
      try {
        off();
      } catch {
        /* observation only */
      }
    }
  };
  const arm = () => {
    if (
      armed ||
      stopped ||
      process.env.FORTIPI_ROOT_CONTEXT_DIAGNOSTICS !== "1" ||
      !integer(invocation, 1, 999) ||
      !["process", "integration"].includes(kind)
    )
      return;
    armed = true;
    for (const stream of [child.stdout, child.stderr]) {
      if (!stream) continue;
      const decoder = new StringDecoder("utf8");
      let partial = "",
        dropping = false,
        consumed = 0;
      const data = (chunk: Buffer | string) => {
        try {
          if (stopped || consumed >= 65536) return;
          const input =
            typeof chunk === "string"
              ? chunk.slice(0, 65536 - consumed)
              : chunk.subarray(0, 65536 - consumed);
          consumed += input.length;
          const text = typeof input === "string" ? input : decoder.write(input);
          for (const char of text) {
            if (char === "\n") {
              // Exactly the raw console line. No stripping arbitrary prefixes or payloads.
              const stage = !dropping && partial.endsWith("\r") ? partial.slice(0, -1) : partial;
              const index =
                !dropping && stage.startsWith(routingPrefix)
                  ? routingStages.indexOf(stage.slice(routingPrefix.length) as Stage)
                  : -1;
              partial = "";
              dropping = false;
              if (index >= 0 && !(mask & (1 << index))) {
                mask |= 1 << index;
                const line = JSON.stringify({
                  diagnostic: "root-routing-v1",
                  kind,
                  invocation,
                  stage: routingStages[index],
                  mask,
                });
                if (rootRoutingDiagnostic(line)) {
                  try {
                    emit(line);
                  } catch {
                    /* original result wins */
                  }
                }
              }
            } else if (!dropping) {
              if (partial.length + char.length > 128) {
                partial = "";
                dropping = true;
              } else partial += char;
            }
          }
          if (consumed >= 65536) {
            partial = "";
            dropping = true;
          }
        } catch {
          /* private malformed data cannot alter the child result */
        }
      };
      stream.on("data", data);
      detach.push(() => {
        stream.off("data", data);
      });
    }
    child.once("close", stop);
    detach.push(() => {
      child.off("close", stop);
    });
  };
  return { arm, stop, mask: () => mask };
}

const root = resolve(import.meta.dirname, "..");
const mains = {
  process: "apps/worker/test/agent/runtime-worker.ts",
  integration: "apps/worker/test/integration/fixture-worker.ts",
};
const cache = new Map<Kind, string>();
/** Prepared diagnostic copies only; absent/invalid preparation leaves the original main. */
export function rootRoutingMain(kind: Kind, main: string): string {
  if (
    process.env.FORTIPI_ROOT_CONTEXT_DIAGNOSTICS !== "1" ||
    resolve(main) !== resolve(root, mains[kind])
  )
    return main;
  if (cache.has(kind)) return cache.get(kind) as string;
  try {
    const directory = resolve(root, ".agent-docs/tmp/root-routing");
    const path = resolve(directory, `${kind}.mjs`),
      metadataPath = resolve(directory, "prepared.json");
    const metadataStat = lstatSync(metadataPath),
      mainStat = lstatSync(path);
    if (
      !metadataStat.isFile() ||
      !mainStat.isFile() ||
      metadataStat.isSymbolicLink() ||
      mainStat.isSymbolicLink() ||
      metadataStat.size > 4096 ||
      mainStat.size > 8_000_000
    )
      return main;
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    const bytes = readFileSync(path);
    if (
      metadata.version !== 1 ||
      metadata[kind] !== createHash("sha256").update(bytes).digest("hex")
    )
      return main;
    cache.set(kind, path);
    return path;
  } catch {
    return main;
  }
}

/** Only the original pinned bin for a selected diagnostic main can use the shadow entry. */
export function rootRoutingWrangler(wrangler: string, main: string): string {
  if (process.env.FORTIPI_ROOT_CONTEXT_DIAGNOSTICS !== "1" || ![...cache.values()].includes(main))
    return wrangler;
  try {
    const require = createRequire(resolve(root, "apps/worker/package.json"));
    const original = resolve(dirname(require.resolve("wrangler/package.json")), "bin/wrangler.js");
    if (resolve(wrangler) !== original) return wrangler;
    const directory = resolve(root, ".agent-docs/tmp/root-routing"),
      entry = resolve(directory, "entry.cjs");
    const metadataPath = resolve(directory, "prepared.json");
    const metadataStat = lstatSync(metadataPath),
      entryStat = lstatSync(entry);
    if (
      !metadataStat.isFile() ||
      !entryStat.isFile() ||
      metadataStat.isSymbolicLink() ||
      entryStat.isSymbolicLink() ||
      metadataStat.size > 4096 ||
      entryStat.size > 8192
    )
      return wrangler;
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    if (
      metadata.version !== 1 ||
      metadata.entry !== createHash("sha256").update(readFileSync(entry)).digest("hex")
    )
      return wrangler;
    return entry;
  } catch {
    return wrangler;
  }
}
