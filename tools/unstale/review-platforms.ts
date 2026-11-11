import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { repository } from "../../scripts/build-workspaces.ts";
import type { Manifest } from "../../scripts/check-pins.ts";
import { json } from "../../scripts/check-pins.ts";
import { hash } from "./review-supply-chain.ts";

async function bytes(url: string): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  assert.ok(response.ok, `${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function image(host: string, repo: string, digest: string): Promise<unknown> {
  // Anonymous, public read scope only; never persist or print the registry token.
  const tokenURL =
    host === "ghcr.io"
      ? `https://ghcr.io/token?service=ghcr.io&scope=repository:${repo}:pull`
      : `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repo}:pull`;
  const auth = JSON.parse((await bytes(tokenURL)).toString()) as { token: string };
  const request = async (path: string): Promise<Buffer> => {
    const response = await fetch(`https://${host}/v2/${repo}/${path}`, {
      headers: {
        Authorization: `Bearer ${auth.token}`,
        Accept:
          "application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json",
      },
      signal: AbortSignal.timeout(60_000),
    });
    assert.ok(response.ok, `Public OCI ${repo}: HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  };
  const raw = await request(`manifests/${digest}`);
  assert.equal(`sha256:${hash(raw)}`, digest, `OCI manifest digest ${repo}`);
  const manifest = JSON.parse(raw.toString()) as {
    config: { digest: string };
    layers: { digest: string; size: number }[];
  };
  const config = await request(`blobs/${manifest.config.digest}`);
  assert.equal(`sha256:${hash(config)}`, manifest.config.digest);
  const runtime = JSON.parse(config.toString()) as { architecture: string; os: string };
  assert.equal(runtime.architecture, "amd64");
  assert.equal(runtime.os, "linux");
  return {
    repository: `${host}/${repo}`,
    digest,
    config: manifest.config.digest,
    architecture: runtime.architecture,
    os: runtime.os,
    layers: manifest.layers,
    observation:
      "Manifest and config bytes verified; layers/build/runtime/image license inventory remain owner3 evidence",
  };
}

async function main(): Promise<void> {
  const manifest = await json<Manifest>(repository, "package.json");
  const actions: unknown[] = [];
  const pins = {
    ...manifest.fortipi?.actions,
    "pre-commit/pre-commit-hooks": {
      version: "v6.0.0",
      sha: "3e8a8703264a2f4a69428a0aa4dcb512790b2c8c",
    },
    "gitleaks/gitleaks": { version: "v8.30.1", sha: "83d9cd684c87d95d656c1458ef04895a7f1cbd8e" },
  };
  for (const [repo, pin] of Object.entries(pins)) {
    const tags = (
      await promisify(execFile)(
        "git",
        [
          "ls-remote",
          `https://github.com/${repo}.git`,
          `refs/tags/${pin.version}`,
          `refs/tags/${pin.version}^{}`,
        ],
        { timeout: 60_000 },
      )
    ).stdout
      .trim()
      .split("\n");
    const commit = (tags.find((line) => line.endsWith("^{}")) ?? tags[0])?.split(/\s/)[0];
    assert.equal(commit, pin.sha, `Action/hook release moved: ${repo}`);
    let license: Buffer | undefined;
    for (const name of ["LICENSE", "LICENSE.md", "LICENSE.txt"]) {
      const response = await fetch(`https://raw.githubusercontent.com/${repo}/${pin.sha}/${name}`, {
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status === 404) continue;
      assert.ok(response.ok);
      license = Buffer.from(await response.arrayBuffer());
      break;
    }
    assert.ok(license, `No reviewed license text for ${repo}`);
    assert.ok(
      /Permission is hereby granted|Apache License|MIT License/i.test(license.toString()),
      `Review tool license ${repo}`,
    );
    const path = `tools/unstale/licenses/${repo}/${pin.sha}/LICENSE`;
    await mkdir(dirname(resolve(repository, path)), { recursive: true });
    await writeFile(resolve(repository, path), license);
    actions.push({ repository: repo, ...pin, licenseSha256: hash(license), licensePath: path });
  }
  const images = [
    await image(
      "ghcr.io",
      "cloudflare/computer-computerd-linux-x64",
      "sha256:6ec793fa80f109acf8b3cd4e295284cfed97f61c03030b780a612ec22c49b294",
    ),
    await image(
      "registry-1.docker.io",
      "library/debian",
      "sha256:7378260c0a098d27ac206225db5e7d92b8c7c84ea7afccc86eeb513756bbd392",
    ),
  ];
  const dockerURL = "https://download.docker.com/linux/static/stable/x86_64/docker-29.9.3.tgz";
  const docker = await bytes(dockerURL);
  await mkdir(resolve(repository, "dist/toolchain"), { recursive: true });
  await writeFile(resolve(repository, "dist/toolchain/docker-29.9.3.tgz"), docker);
  const output = {
    format: 1,
    reviewedAt: new Date().toISOString(),
    actions,
    images,
    docker: {
      version: "29.9.3",
      buildkit: "0.34.2",
      url: dockerURL,
      sha256: hash(docker),
      license: "Apache-2.0",
      securityReference: "https://docs.docker.com/engine/release-notes/29/",
      observation:
        "Official static Linux x64 archive identity; run actual daemon/image build on Linux before claiming compatibility",
    },
    fuse: {
      fuse3: "3.17.2-3",
      libfuse3: "3.17.2-3",
      libfuse2t64: "2.9.9-9",
      observation:
        "Owner3 freezes dated Debian snapshot and transitive inventory; separate OS licensing gate",
    },
  };
  await writeFile(
    resolve(repository, "tools/unstale/platform-tools.json"),
    `${JSON.stringify(output, null, 2)}\n`,
  );
  console.log(
    "Reviewed Action/hook tag identities/licenses, public OCI manifests/configs and official Docker archive; no runtime/image claim",
  );
}

if (import.meta.main) await main();
