import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mock, test } from "node:test";
import type { Source } from "./catalog.ts";
import { type Baseline, check, exitCode, githubRequest, hash, observer, summary } from "./watch.ts";

const fixture = JSON.parse(
  await readFile(new URL("fixtures/upstream.json", import.meta.url), "utf8"),
) as {
  head: { object: { type: string; sha: string } };
  directory: { name: string; path: string; type: string; sha: string }[];
  release: Record<string, unknown>;
};
const source: Source = {
  id: "runtime",
  repo: "owner/runtime",
  ref: "main",
  paths: ["runtime"],
  pins: [],
  review: "Review task recovery and native ABI against the pinned runtime.",
  links: [],
};
const pins = async () => ({});
const request = async (path: string): Promise<unknown> => {
  if (path.includes("git/ref/heads/")) return structuredClone(fixture.head);
  assert.equal(path, `repos/owner/runtime/contents/runtime?ref=${fixture.head.object.sha}`);
  return structuredClone(fixture.directory);
};
const initial = await observer(request)(source);
const baseline: Baseline = {
  format: 1,
  entries: {
    runtime: {
      catalogSha256: hash(source),
      snapshot: initial,
      pins: {},
      reviewedAt: "2026-11-11T00:00:00Z",
      reviewNote: "Synthetic reviewed reference; no actual runtime compatibility claim.",
    },
  },
};

test("matching reference succeeds; recursive code drift at the same version requires review and an exact diff", async () => {
  const same = await check(baseline, observer(request), pins, [source]);
  assert.equal(exitCode(same), 0);
  assert.equal(same[0]?.classification, "reviewed-reference");
  // Fault: only a nested src tree changes, without a package version bump.
  const changed = observer(async (path) =>
    path.includes("git/ref/heads/")
      ? { object: { type: "commit", sha: "dddddddddddddddddddddddddddddddddddddddd" } }
      : fixture.directory.map((entry) =>
          entry.name === "src"
            ? { ...entry, sha: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" }
            : entry,
        ),
  );
  const result = await check(baseline, changed, pins, [source]);
  assert.equal(exitCode(result), 1);
  assert.equal(result[0]?.outcome, "review-required");
  assert.equal(result[0]?.classification, "unknown");
  assert.ok(
    result[0]?.links.some((l) =>
      l.endsWith(`/compare/${fixture.head.object.sha}...dddddddddddddddddddddddddddddddddddddddd`),
    ),
  );
  assert.match(summary(result), /runtime: review-required/);
});

test("release-note edits and moved tags require review; branch targets resolve to actual tag commits", async () => {
  const release: Source = { ...source, paths: [], ref: "" };
  const observed = await observer(async (path) =>
    path.endsWith("releases/latest") ? fixture.release : fixture.head,
  )(release);
  assert.equal(observed.commit, fixture.head.object.sha);
  assert.equal(observed.version, "v1.0.0");
  const prior = baseline.entries.runtime;
  assert.ok(prior);
  const reviewed: Baseline = {
    format: 1,
    entries: {
      runtime: {
        ...prior,
        catalogSha256: hash(release),
        snapshot: observed,
      },
    },
  };
  const result = await check(
    reviewed,
    observer(async (path) =>
      path.endsWith("releases/latest")
        ? { ...fixture.release, body: "Corrected API warning." }
        : fixture.head,
    ),
    pins,
    [release],
  );
  assert.equal(exitCode(result), 1);
  assert.equal(result[0]?.outcome, "review-required");
  assert.ok(result[0]?.links.includes("https://github.com/owner/runtime/releases/tag/v1.0.0"));
  const retagged = await check(
    reviewed,
    observer(async (path) =>
      path.endsWith("releases/latest")
        ? fixture.release
        : { object: { type: "commit", sha: "dddddddddddddddddddddddddddddddddddddddd" } },
    ),
    pins,
    [release],
  );
  assert.equal(exitCode(retagged), 1);
});

test("missing/unreviewed baselines, foreign responses and local pin drift cannot produce an all-clear", async () => {
  for (const invalid of [
    null,
    { format: 1, entries: {} },
    { format: 2, entries: baseline.entries },
  ]) {
    assert.equal(exitCode(await check(invalid, observer(request), pins, [source])), 2);
  }
  const invalid = structuredClone(baseline);
  assert.ok(invalid.entries.runtime);
  invalid.entries.runtime.reviewNote = "";
  assert.equal(exitCode(await check(invalid, observer(request), pins, [source])), 2);
  assert.equal(
    exitCode(
      await check(baseline, observer(request), pins, [
        { ...source, review: "Unreviewed catalog edit" },
      ]),
    ),
    2,
  );
  for (const response of [
    [],
    [{ name: "src", path: "runtime/src", type: "dir", sha: "not-a-hash" }],
    { message: "unexpected API shape" },
    Array.from({ length: 1000 }, () => fixture.directory[0]),
  ]) {
    assert.equal(
      exitCode(
        await check(
          baseline,
          observer(async (p) => (p.includes("git/ref/") ? fixture.head : response)),
          pins,
          [source],
        ),
      ),
      2,
    );
  }
  const result = await check(
    baseline,
    observer(request),
    async () => ({ "package.json#pin": "2.0.0" }),
    [source],
  );
  assert.equal(exitCode(result), 1);
  assert.equal(exitCode([]), 2);
});

test("public HTTP failure, timeout, malformed JSON and size limits fail closed with bounded GETs and no credential output", async () => {
  for (const [mode, expected] of [
    ["http", "check-unavailable"],
    ["timeout", "check-unavailable"],
    ["json", "unknown"],
    ["oversize", "unknown"],
  ] as const) {
    const fetchMock = mock.method(
      globalThis,
      "fetch",
      async (url: string, options: RequestInit) => {
        assert.ok(url.startsWith("https://api.github.com/repos/"));
        assert.equal(options.method, "GET");
        assert.equal(options.redirect, "error");
        assert.ok(options.signal);
        if (mode === "timeout") throw new Error("synthetic transport failure");
        if (mode === "http")
          return new Response("Untrusted server body must never be logged", { status: 429 });
        return new Response(mode === "json" ? "not-json" : "x".repeat(512 * 1024 + 1), {
          headers: { "content-type": "application/json" },
        });
      },
    );
    try {
      const result = await check(baseline, observer(githubRequest()), pins, [source]);
      assert.equal(exitCode(result), 2);
      assert.equal(result[0]?.outcome, expected);
      assert.equal(fetchMock.mock.callCount(), 1, "No retry after failure");
      assert.ok(!JSON.stringify(result).includes("Untrusted server body"));
    } finally {
      fetchMock.mock.restore();
    }
  }
  const boundedFetch = mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response("{}", {
        headers: { "content-type": "application/json" },
      }),
  );
  try {
    const request = githubRequest();
    for (let i = 0; i < 64; i++) await request("repos/owner/runtime/releases/latest");
    await assert.rejects(
      request("repos/owner/runtime/releases/latest"),
      /Run request\/time bound reached/,
    );
    assert.equal(boundedFetch.mock.callCount(), 64);
  } finally {
    boundedFetch.mock.restore();
  }
});
