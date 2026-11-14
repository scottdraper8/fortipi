// Controlled observations over actual source facts, NOT a fresh upstream/provider observation.

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { sources } from "../catalog.ts";
import { type CompatibilityReport, releaseBasis, releaseHash } from "../release.ts";
import { type Baseline, check, exitCode, localPins } from "../watch.ts";
export async function controlledCompatibility(root: string) {
  const source = (
    await promisify(execFile)("git", ["rev-parse", "HEAD"], { cwd: root })
  ).stdout.trim();
  const basis = await releaseBasis(root, source);
  const baseline = JSON.parse(
    await readFile(resolve(root, "tools/compatibility-watch/baseline.json"), "utf8"),
  ) as Baseline & {
    releaseReference: { references: CompatibilityReport["requiredReferences"]["installed"] };
  };
  const results = await check(
    baseline,
    async (source) => structuredClone(baseline.entries[source.id]!.snapshot),
    (source) => localPins(source, root),
  );
  const checkedAt = new Date().toISOString();
  const report: CompatibilityReport = {
    format: 2,
    sourceCommit: source,
    checkedAt,
    catalogSha256: releaseHash(sources),
    baselineSha256: releaseHash(baseline),
    cohortSha256: basis.cohortSha256,
    validationInputs: basis.validationInputs,
    lookahead: { format: 1, checkedAt, results, exitCode: exitCode(results) },
    requiredReferences: {
      current: results.filter((r) => !Object.hasOwn(baseline.releaseReference.references, r.id)),
      installed: baseline.releaseReference.references,
    },
  };
  return { basis, baseline, report };
}
