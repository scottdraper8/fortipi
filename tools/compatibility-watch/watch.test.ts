import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mock, test } from "node:test";
import type { Source } from "./catalog.ts";
import { sources } from "./catalog.ts";
import {
  type Baseline,
  check,
  exitCode,
  githubRequest,
  hash,
  localPins,
  observer,
  summary,
} from "./watch.ts";

const fixture = JSON.parse(
  await readFile(new URL("fixtures/upstream.json", import.meta.url), "utf8"),
) as {
  head: { object: { type: string; sha: string } };
  directory: { name: string; path: string; type: string; sha: string }[];
  release: Record<string, unknown>;
  meson: {
    release: Record<string, unknown>;
    tagRef: { object: { type: string; sha: string } };
    tag: { object: { type: string; sha: string } };
  };
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

test("Durable Object code-update and lifecycle policy edits independently require review", async (t) => {
  const durable = sources.find((item) => item.id === "durable-objects-policy");
  assert.ok(durable);
  const policies = [
    "src/content/docs/durable-objects/deployments/durable-objects-code-updates.mdx",
    "src/content/docs/durable-objects/concepts/durable-object-lifecycle.mdx",
  ];
  const observed = (changed?: string) =>
    observer(async (path) => {
      if (path.includes("git/ref/heads/")) return structuredClone(fixture.head);
      const prefix = "repos/cloudflare/cloudflare-docs/contents/";
      assert.ok(path.startsWith(prefix));
      const file = path.slice(prefix.length).split("?")[0];
      assert.ok(file && durable.paths.includes(file));
      return policies.includes(file)
        ? { path: file, type: "file", sha: (file === changed ? "b" : "a").repeat(40) }
        : [{ name: "limits.mdx", path: `${file}/limits.mdx`, type: "file", sha: "a".repeat(40) }];
    });
  const reviewed: Baseline = {
    format: 1,
    entries: {
      [durable.id]: {
        catalogSha256: hash(durable),
        snapshot: await observed()(durable),
        pins: {},
        reviewedAt: "2026-11-11T00:00:00Z",
        reviewNote: "Synthetic policy reference; no actual runtime or deployment claim.",
      },
    },
  };
  assert.equal(exitCode(await check(reviewed, observed(), pins, [durable])), 0);
  for (const policy of policies) {
    await t.test(policy, async () => {
      // Only this file's identity changes; the head and the other policy paths stay fixed.
      const result = await check(reviewed, observed(policy), pins, [durable]);
      assert.equal(result[0]?.outcome, "review-required", policy);
      assert.equal(result[0]?.classification, "unknown");
      assert.equal(exitCode(result), 1);
      assert.ok(
        result[0]?.links.includes(
          `https://github.com/cloudflare/cloudflare-docs/tree/${fixture.head.object.sha}/${policy}`,
        ),
      );
    });
  }
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

test("Meson annotated release resolves the source commit; moved tags, notes and archive/license pins require review", async () => {
  const meson = sources.find((item) => item.id === "meson");
  assert.ok(meson);
  const reviewed = JSON.parse(
    await readFile(new URL("baseline.json", import.meta.url), "utf8"),
  ) as Baseline;
  const prior = reviewed.entries.meson;
  assert.ok(prior);
  const onlyMeson: Baseline = { format: 1, entries: { meson: prior } };
  const requests: string[] = [];
  const mesonRequest = async (path: string): Promise<unknown> => {
    requests.push(path);
    switch (path) {
      case "repos/mesonbuild/meson/releases/latest":
        return fixture.meson.release;
      case "repos/mesonbuild/meson/git/ref/tags/1.12.1":
        return fixture.meson.tagRef;
      case "repos/mesonbuild/meson/git/tags/958d178d20ffa043ed64a95e3e7af3632b4d1c45":
        return fixture.meson.tag;
      default:
        assert.fail(`Unexpected Meson request: ${path}`);
    }
  };
  const observed = await observer(mesonRequest)(meson);
  assert.equal(requests.length, 3);
  assert.equal(observed.commit, "70598bb7825f0f804fb31ec2795de5e79e7692a0");
  assert.equal(observed.version, "1.12.1");
  assert.deepEqual(observed, prior.snapshot);
  assert.equal(exitCode(await check(onlyMeson, observer(mesonRequest), localPins, [meson])), 0);

  for (const change of [
    async (path: string) =>
      path.includes("git/tags/")
        ? { object: { type: "commit", sha: "d".repeat(40) } }
        : mesonRequest(path),
    async (path: string) =>
      path.endsWith("releases/latest")
        ? { ...fixture.meson.release, body: "Changed Python/build-option warning." }
        : mesonRequest(path),
  ]) {
    const result = await check(onlyMeson, observer(change), localPins, [meson]);
    assert.equal(exitCode(result), 1);
    assert.equal(result[0]?.classification, "unknown");
    assert.ok(result[0]?.links.includes("https://github.com/mesonbuild/meson/releases/tag/1.12.1"));
  }
  for (const key of ["source", "sourceArchiveSha256", "licenseSha256"]) {
    const changed = {
      ...(await localPins(meson)),
      [`tools/unstale/platform-tools.json#meson/${key}`]: "0".repeat(64),
    };
    const result = await check(onlyMeson, observer(mesonRequest), async () => changed, [meson]);
    assert.equal(exitCode(result), 1);
    assert.equal(result[0]?.outcome, "review-required");
  }
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
