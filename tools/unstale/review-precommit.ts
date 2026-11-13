import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../../packages/fortipi-contract/src/canonical-json.ts";
import { precommitLock, sha256 } from "./precommit-python.ts";

/** Check an existing reviewed closure, never choose versions or modify its lock. */
export async function reviewPrecommit(): Promise<unknown> {
  const lock = await precommitLock();
  const queries = lock.packages.map((entry) => ({
    package: { ecosystem: "PyPI", name: entry.name },
    version: entry.version,
  }));
  for (const entry of lock.packages) {
    const response = await fetch(
      `https://pypi.org/pypi/${encodeURIComponent(entry.name)}/${entry.version}/json`,
      { redirect: "error", signal: AbortSignal.timeout(60000) },
    );
    assert.ok(response.ok, "Python metadata unavailable");
    const metadata = (await response.json()) as {
      info: {
        requires_dist: string[] | null;
        requires_python: string | null;
        license_expression: string | null;
        license: string;
      };
      urls: { filename: string; size: number; digests: { sha256: string }; yanked: boolean }[];
    };
    assert.deepEqual(
      metadata.info.requires_dist ?? [],
      entry.requiresDist,
      "Python dependency metadata changed",
    );
    assert.equal(metadata.info.requires_python, entry.requiresPython);
    assert.equal(metadata.info.license_expression || metadata.info.license, entry.license);
    if (entry.name === "pre-commit-hooks") continue; // Installed from the retained repository SHA, not the mismatching PyPI wheel.
    const artifact = metadata.urls.find((file) => file.filename === entry.filename);
    assert.ok(artifact && !artifact.yanked, "Reviewed Python archive absent/yanked");
    assert.equal(artifact.size, entry.size);
    assert.equal(artifact.digests.sha256, entry.sha256);
  }
  for (const entry of lock.supportArchives) {
    const response = await fetch("https://pypi.org/pypi/Cython/3.3.1/json", {
      redirect: "error",
      signal: AbortSignal.timeout(60000),
    });
    assert.ok(response.ok);
    const metadata = (await response.json()) as {
      urls: { filename: string; size: number; digests: { sha256: string }; yanked: boolean }[];
    };
    const artifact = metadata.urls.find((file) => file.filename === entry.filename);
    assert.ok(artifact && !artifact.yanked);
    assert.equal(artifact.size, entry.size);
    assert.equal(artifact.digests.sha256, entry.sha256);
  }
  const response = await fetch("https://api.osv.dev/v1/querybatch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ queries }),
    redirect: "error",
    signal: AbortSignal.timeout(60000),
  });
  assert.ok(response.ok, "PyPI advisory review unavailable");
  const raw = Buffer.from(await response.arrayBuffer());
  const advisory = JSON.parse(raw.toString()) as { results: { vulns?: { id: string }[] }[] };
  assert.equal(advisory.results.length, queries.length);
  assert.ok(
    advisory.results.every((entry) => !entry.vulns?.length),
    "Actionable Python advisory; review required",
  );
  const bundled = JSON.parse(
    await readFile(
      resolve(dirname(fileURLToPath(import.meta.url)), "precommit-vendored.json"),
      "utf8",
    ),
  ) as {
    components: { name: string; version: string; archive: string }[];
    pipSubset: { archiveSha256: string; advisories: { id: string; sha256: string }[] };
  };
  assert.equal(
    lock.packages.find((p) => p.name === "pip")?.sha256,
    bundled.pipSubset.archiveSha256,
    "Pip subset applicability changed",
  );
  const bundledResponse = await fetch("https://api.osv.dev/v1/querybatch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      queries: bundled.components.map((p) => ({
        package: { ecosystem: "PyPI", name: p.name },
        version: p.version,
      })),
    }),
    redirect: "error",
    signal: AbortSignal.timeout(60000),
  });
  assert.ok(bundledResponse.ok);
  const bundledRaw = Buffer.from(await bundledResponse.arrayBuffer());
  const bundledFindings = JSON.parse(bundledRaw.toString()) as {
    results: { vulns?: { id: string }[] }[];
  };
  assert.equal(bundledFindings.results.length, bundled.components.length);
  const known = bundled.pipSubset.advisories.map((p) => p.id).sort();
  const observed = new Set<string>();
  for (const [index, result] of bundledFindings.results.entries())
    for (const finding of result.vulns ?? []) {
      const component = bundled.components[index];
      assert.ok(
        component &&
          component.name === "setuptools" &&
          component.version === "70.3.0" &&
          component.archive === "pip-26.3-py3-none-any.whl" &&
          known.includes(finding.id),
        "New bundled Python advisory requires review",
      );
      observed.add(finding.id);
    }
  assert.deepEqual([...observed].sort(), known, "Bundled advisory assessment changed");
  for (const finding of bundled.pipSubset.advisories) {
    const response = await fetch(`https://api.osv.dev/v1/vulns/${finding.id}`, {
      redirect: "error",
      signal: AbortSignal.timeout(60000),
    });
    assert.ok(response.ok);
    assert.equal(
      sha256(canonicalJson(await response.json())),
      finding.sha256,
      "Bundled advisory record changed; rereview applicability",
    );
  }
  return {
    checkedAt: new Date().toISOString(),
    lockSha256: sha256(JSON.stringify(lock)),
    packages: queries.length,
    findings: 0,
    advisoryResponseSha256: sha256(raw),
    bundledQueries: bundled.components.length,
    bundledSubsetFindings: known,
    bundledResponseSha256: sha256(bundledRaw),
    scope:
      "Exact direct/runtime/build distributions. Bundled upstream components and source correspondence are recorded in precommit-python-review.md; this is not a product distribution or platform execution claim.",
  };
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    assert.ok(args.length === 0 || (args.length === 2 && args[0] === "--out" && args[1]));
    const result = await reviewPrecommit();
    if (args[1]) {
      const destination = resolve(args[1]);
      // Evidence may be written only when explicitly requested; no automatic policy refresh.
      await writeFile(destination, `${JSON.stringify(result, null, 2)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      assert.ok(await readFile(destination));
    }
    console.log(JSON.stringify(result));
  } catch {
    console.error("Pinned Python metadata/advisory review failed; no lock changed");
    process.exitCode = 1;
  }
}
