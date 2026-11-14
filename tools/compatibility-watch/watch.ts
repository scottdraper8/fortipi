import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { type Source, sources } from "./catalog.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const sha = /^[a-f0-9]{40}$/;
const digest = /^[a-f0-9]{64}$/;
export const hash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
type JsonObject = Record<string, unknown>;
function object(value: unknown): JsonObject {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), "Unrecognized object");
  return value as JsonObject;
}
function text(value: unknown): string {
  assert.ok(
    typeof value === "string" &&
      value.length > 0 &&
      value.length <= 256 &&
      [...value].every((character) => character.charCodeAt(0) >= 32),
    "Unrecognized string",
  );
  return value;
}
class Unavailable extends Error {}
export type Request = (path: string) => Promise<unknown>;

/** Fixed public host, GET only, no redirects, retries, response bodies in errors or secret output. */
export function githubRequest(useGh = false): Request {
  const total = AbortSignal.timeout(90_000);
  let requests = 0;
  return async (path) => {
    assert.ok(/^repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\//.test(path));
    if (++requests > 64 || total.aborted) throw new Unavailable("Run request/time bound reached");
    const signal = AbortSignal.any([total, AbortSignal.timeout(10_000)]);
    let body: string;
    if (useGh) {
      // Optional local public reads through existing gh auth; never read/expose its credential.
      body = await new Promise<string>((accept, reject) => {
        execFile(
          "gh",
          ["api", "--hostname", "github.com", "--method", "GET", path],
          { signal, timeout: 10_000, maxBuffer: 512 * 1024, encoding: "utf8" },
          (error, stdout) =>
            error ? reject(new Unavailable("GitHub read failed (gh)")) : accept(stdout),
        );
      });
    } else {
      const headers: Record<string, string> = {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      };
      if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
      let response: Response;
      try {
        response = await fetch(`https://api.github.com/${path}`, {
          method: "GET",
          headers,
          signal,
          redirect: "error",
        });
      } catch {
        throw new Unavailable("GitHub read timed out or transport failed");
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Unavailable(
          `GitHub HTTP ${response.status}; retry after restoring source access`,
        );
      }
      assert.ok(
        response.headers.get("content-type")?.includes("application/json"),
        "Unrecognized content type",
      );
      assert.ok(response.body, "Missing response body");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          assert.ok(bytes <= 512 * 1024, "Response exceeds review bound");
          chunks.push(part.value);
        }
      } catch (error) {
        await reader.cancel().catch(() => {});
        if (signal.aborted) throw new Unavailable("GitHub body read timed out");
        throw error;
      } finally {
        reader.releaseLock();
      }
      body = Buffer.concat(chunks).toString("utf8");
    }
    return JSON.parse(body) as unknown;
  };
}

export interface Snapshot {
  commit: string;
  version: string | null;
  sha256: string;
  paths: Record<string, string>;
}
export interface BaselineEntry {
  catalogSha256: string;
  snapshot: Snapshot;
  pins: Record<string, string>;
  reviewedAt: string;
  reviewNote: string;
}
export interface Baseline {
  format: 1;
  entries: Record<string, BaselineEntry>;
}
export interface Result {
  id: string;
  outcome: "unchanged" | "review-required" | "check-unavailable" | "unknown";
  classification: "reviewed-reference" | "unknown";
  baseline: Snapshot | null;
  observed: Snapshot | null;
  pins: Record<string, string> | null;
  action: string;
  links: string[];
}

function fileIdentity(value: unknown, path: string): string {
  const item = object(value);
  assert.equal(item.path, path);
  assert.equal(item.type, "file");
  assert.match(text(item.sha), sha);
  return hash({ path, sha: item.sha });
}
function pathIdentity(value: unknown, path: string): string {
  if (!Array.isArray(value)) return fileIdentity(value, path);
  // GitHub caps Contents at 1000 entries. Refuse possible truncation.
  assert.ok(value.length > 0 && value.length < 1000, "Empty or possibly truncated directory");
  const entries = value
    .map((v) => {
      const item = object(v);
      const name = text(item.name);
      assert.ok(!name.includes("/") && name !== "." && name !== "..");
      assert.equal(item.path, `${path}/${name}`);
      assert.match(text(item.sha), sha);
      assert.ok(["file", "dir", "symlink", "submodule"].includes(text(item.type)));
      return { name, type: item.type, sha: item.sha };
    })
    .sort((a, b) => a.name.localeCompare(b.name, "en"));
  assert.equal(new Set(entries.map((e) => e.name)).size, entries.length);
  // Directory entries carry recursive Git tree hashes, so src/native subtree edits count.
  return hash(entries);
}

export function observer(request: Request): (source: Source) => Promise<Snapshot> {
  const heads = new Map<string, Promise<string>>();
  return async (source) => {
    const base = `repos/${source.repo}/`;
    if (!source.paths.length) {
      const release = object(await request(`${base}releases/latest`));
      assert.equal(release.draft, false);
      assert.equal(release.prerelease, false);
      assert.ok(Number.isSafeInteger(release.id) && Number(release.id) > 0);
      const version = text(release.tag_name);
      assert.match(version, /^[A-Za-z0-9@._/+-]+$/);
      const target = text(release.target_commitish);
      assert.ok(typeof release.body === "string");
      assert.ok(Number.isFinite(Date.parse(text(release.published_at))));
      const tagRef = object(await request(`${base}git/ref/tags/${encodeURIComponent(version)}`));
      let tag = object(tagRef.object);
      assert.match(text(tag.sha), sha);
      const tagSha = tag.sha;
      if (tag.type === "tag") {
        tag = object(object(await request(`${base}git/tags/${tagSha}`)).object);
      }
      assert.equal(tag.type, "commit");
      const commit = text(tag.sha);
      assert.match(commit, sha);
      return {
        commit,
        version,
        sha256: hash({
          id: release.id,
          version,
          target,
          tagSha,
          commit,
          publishedAt: release.published_at,
          body: release.body,
        }),
        paths: {},
      };
    }
    const key = `${source.repo}/${source.ref}`;
    if (!heads.has(key))
      heads.set(
        key,
        (async () => {
          const head = object(await request(`${base}git/ref/heads/${source.ref}`));
          const ref = object(head.object);
          assert.equal(ref.type, "commit");
          const commit = text(ref.sha);
          assert.match(commit, sha);
          return commit;
        })(),
      );
    const commit = await heads.get(key);
    assert.ok(commit);
    const paths: Record<string, string> = {};
    let version: string | null = null;
    for (const path of source.paths) {
      const value = await request(`${base}contents/${path}?ref=${commit}`);
      paths[path] = pathIdentity(value, path);
      if (path === source.manifest?.path) {
        const file = object(value);
        assert.equal(file.encoding, "base64");
        assert.ok(typeof file.content === "string");
        const bytes = Buffer.from(file.content, "base64");
        assert.equal(bytes.byteLength, file.size);
        assert.equal(
          createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex"),
          file.sha,
        );
        const manifest = object(JSON.parse(bytes.toString("utf8")));
        assert.equal(manifest.name, source.manifest.name);
        version = text(manifest.version);
      }
    }
    return { commit, version, paths, sha256: hash(paths) };
  };
}

export async function localPins(source: Source, directory = root): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const pin of source.pins) {
    let value: unknown = JSON.parse(await readFile(resolve(directory, pin.file), "utf8"));
    for (const key of pin.keys) value = object(value)[key];
    result[`${pin.file}#${pin.keys.join("/")}`] = text(value);
  }
  return result;
}
function baselineEntry(value: unknown, source: Source): BaselineEntry {
  const entry = object(value);
  assert.equal(entry.catalogSha256, hash(source), "Catalog changed without review");
  assert.ok(
    Number.isFinite(Date.parse(text(entry.reviewedAt))) &&
      Date.parse(String(entry.reviewedAt)) <= Date.now() + 60_000,
  );
  assert.ok(
    typeof entry.reviewNote === "string" &&
      entry.reviewNote.trim().length > 20 &&
      entry.reviewNote.length <= 1000,
  );
  const snapshot = object(entry.snapshot);
  assert.match(text(snapshot.sha256), digest);
  assert.match(text(snapshot.commit), sha);
  if (source.paths.length) {
    const paths = object(snapshot.paths);
    assert.deepEqual(Object.keys(paths), source.paths);
    for (const value of Object.values(paths)) assert.match(text(value), digest);
    assert.equal(hash(paths), snapshot.sha256);
  } else {
    assert.deepEqual(snapshot.paths, {});
    text(snapshot.version);
  }
  if (source.manifest) text(snapshot.version);
  else if (source.paths.length) assert.equal(snapshot.version, null);
  const pins = object(entry.pins);
  assert.deepEqual(
    Object.keys(pins),
    source.pins.map((p) => `${p.file}#${p.keys.join("/")}`),
  );
  for (const value of Object.values(pins)) text(value);
  return entry as unknown as BaselineEntry;
}

export async function check(
  baseline: unknown,
  observe: (source: Source) => Promise<Snapshot>,
  pins: (source: Source) => Promise<Record<string, string>> = localPins,
  catalog = sources,
): Promise<Result[]> {
  let entries: JsonObject;
  try {
    const parsed = object(baseline);
    assert.equal(parsed.format, 1);
    entries = object(parsed.entries);
    assert.deepEqual(Object.keys(entries).sort(), catalog.map((s) => s.id).sort());
    assert.ok(
      catalog.length > 0 &&
        catalog.length <= 16 &&
        new Set(catalog.map((s) => s.id)).size === catalog.length,
    );
  } catch {
    return [
      {
        id: "baseline",
        outcome: "unknown",
        classification: "unknown",
        baseline: null,
        observed: null,
        pins: null,
        action:
          "Restore and deliberately review the complete version-1 baseline; no all-clear is possible.",
        links: [],
      },
    ];
  }
  const results: Result[] = [];
  let at = 0;
  await Promise.all(
    Array.from({ length: Math.min(3, catalog.length) }, async () => {
      while (at < catalog.length) {
        const source = catalog[at++];
        assert.ok(source);
        const result: Result = {
          id: source.id,
          outcome: "unknown",
          classification: "unknown",
          baseline: null,
          observed: null,
          pins: null,
          action: source.review,
          links: [...source.links],
        };
        try {
          // Keep observations available for manual review even when an entry is absent/invalid.
          result.observed = await observe(source);
          result.pins = await pins(source);
          const previous = baselineEntry(entries[source.id], source);
          result.baseline = previous.snapshot;
          const base = `https://github.com/${source.repo}`;
          if (!source.paths.length && result.observed.version) {
            result.links.push(
              `${base}/releases/tag/${encodeURIComponent(result.observed.version)}`,
            );
          }
          if (result.observed.commit) {
            result.links.push(`${base}/commit/${result.observed.commit}`);
            if (previous.snapshot.commit)
              result.links.push(
                `${base}/compare/${previous.snapshot.commit}...${result.observed.commit}`,
              );
            for (const path of source.paths)
              result.links.push(`${base}/tree/${result.observed.commit}/${path}`);
          }
          if (
            result.observed.sha256 !== previous.snapshot.sha256 ||
            hash(result.pins) !== hash(previous.pins)
          ) {
            result.outcome = "review-required";
            result.action = `Upstream source or local pin changed; compatibility unknown. ${source.review} Review links and commit only individually reviewed baseline entries.`;
          } else {
            result.outcome = "unchanged";
            result.classification = "reviewed-reference";
            result.action =
              "Matches the reviewed reference; this is not proof of runtime compatibility or full upstream coverage.";
          }
        } catch (error) {
          result.outcome = error instanceof Unavailable ? "check-unavailable" : "unknown";
          result.action = `${error instanceof Unavailable ? error.message : "Unrecognized source, local pin or unreviewed baseline"}. ${source.review} Restore access/schema and review before acknowledging.`;
        }
        results.push(result);
      }
    }),
  );
  return results.sort((a, b) => a.id.localeCompare(b.id));
}

export const exitCode = (results: Result[]): number =>
  results.length === 0
    ? 2
    : results.every((r) => r.outcome === "unchanged")
      ? 0
      : results.some((r) => r.outcome === "unknown" || r.outcome === "check-unavailable")
        ? 2
        : 1;
export function summary(results: Result[]): string {
  return [
    "# Compatibility review",
    "",
    "Read-only references; unchanged does not establish runtime compatibility.",
    "",
    ...results.flatMap((r) => [
      `## ${r.id}: ${r.outcome}`,
      "",
      r.action,
      "",
      `Observed SHA-256: \`${r.observed?.sha256 ?? "unknown"}\`; commit: \`${r.observed?.commit ?? "unknown"}\`; version/tag: \`${r.observed?.version ?? "unknown"}\`.`,
      "",
      ...r.links.map((link) => `- [Review source](${link})`),
      "",
    ]),
  ].join("\n");
}

if (import.meta.main) {
  assert.ok(
    process.argv.slice(2).every((arg) => arg === "--gh" || arg === "--release"),
    "Only --gh (local reads) and --release (strict installed assessment) are supported; no acceptance command exists",
  );
  let baseline: unknown;
  try {
    baseline = JSON.parse(await readFile(new URL("baseline.json", import.meta.url), "utf8"));
  } catch {
    baseline = null;
  }
  const results = await check(baseline, observer(githubRequest(process.argv.includes("--gh"))));
  const checkedAt = new Date().toISOString();
  let report: unknown = { format: 1, checkedAt, results };
  let code = exitCode(results);
  if (process.argv.includes("--release")) {
    try {
      const { createReleaseReport } = await import("./release.ts");
      report = await createReleaseReport(root, results, checkedAt);
      code = 0;
    } catch {
      console.error(
        JSON.stringify({
          diagnostic: "compatibility-release-failure",
          failureClass: "required-assessment",
        }),
      );
      code = 2;
    }
  }
  console.log(JSON.stringify(report, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(process.env.GITHUB_STEP_SUMMARY, summary(results));
  process.exitCode = code;
}
