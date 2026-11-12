import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { paragraphs } from "./debian.ts";
import { check, cleartext, run, sha256 } from "./fuse-security.ts";

// One authenticated trixie-security overlay; unrelated packages retain their dated freeze.
export const securityUpdate = {
  base: "https://security.debian.org/debian-security/",
  version: "1:1.3.dfsg+really1.3.1-1+deb13u1",
  release: "7f4c748c903c3c12e1aded639dd8869f72433b7f396effef764cefdead539e76",
  packages: "393192f8a6ca82969d08b7fd31e1b8c012396f0d787096525506bf528147717c",
  sources: "b9362916f8380bdfcc7c0b4d33bbf2e9efc3895545129fbb4a5b654c457349ac",
  binary: "8c27c342230503b73dfde629642c3b352e87b554e06d60cf58772f236a305ceb",
  descriptor: "7954224611bd043d62c094abf81cefcf9d97276479fc495767fcbc92cc6552f2",
} as const;
type Download = (url: string, expected?: string) => Promise<Uint8Array>;

export async function authenticateSecurityUpdate(download: Download, output: string) {
  const directory = resolve(output, "security");
  await mkdir(directory, { recursive: true });
  const path = resolve(directory, "trixie-security.InRelease");
  // Preserve the signed authority itself across rotating publication URLs.
  const authority = await readFile(new URL("./trixie-security.InRelease", import.meta.url));
  check(sha256(authority) === securityUpdate.release, "Frozen security authority drift");
  await writeFile(path, authority);
  const home = await mkdtemp(resolve(output, "security-gpgv-"));
  try {
    const status = (
      await run("gpgv", [
        "--homedir",
        home,
        "--keyring",
        resolve(directory, "archive-keyring.pgp"),
        "--status-fd",
        "1",
        path,
      ])
    ).toString();
    const signers = [
      "B0CAB9266E8C3929798B3EEEBDE6D2B9216EC7A8",
      "89C87ACEA5DD6B8E6A7068808E9F831205B4BA95",
    ];
    check(
      status
        .split("\n")
        .some(
          (line) =>
            line.startsWith("[GNUPG:] VALIDSIG ") && signers.includes(line.split(" ")[2] ?? ""),
        ),
      "Unexpected Debian security signer",
    );
    const release = paragraphs(cleartext(await readFile(path)))[0];
    check(release?.get("Codename") === "trixie-security", "Wrong security codename");
    const rows = (release.get("SHA256") ?? "")
      .trim()
      .split("\n")
      .map((line) => line.trim().split(/\s+/));
    const indexes = [];
    for (const [name, hash] of [
      ["main/binary-amd64/Packages.xz", securityUpdate.packages],
      ["main/source/Sources.xz", securityUpdate.sources],
    ]) {
      const row = rows.find((row) => row[2] === name);
      check(
        row && row[0] === hash && name && hash,
        "Security index is not bound to signed Release",
      );
      const prefix = name.slice(0, name.lastIndexOf("/") + 1);
      const bytes = await download(
        `${securityUpdate.base}dists/trixie-security/${prefix}by-hash/SHA256/${hash}`,
        hash,
      );
      check(bytes.length === Number(row[1]), "Security index size mismatch");
      const file = resolve(directory, `trixie-security-${name?.replaceAll("/", "-")}`);
      await writeFile(file, bytes);
      indexes.push(paragraphs((await run("xz", ["--decompress", "--stdout", file])).toString()));
    }
    const binary = indexes[0]?.find(
      (row) =>
        row.get("Package") === "zlib1g" &&
        row.get("Version") === securityUpdate.version &&
        row.get("Architecture") === "amd64",
    );
    const source = indexes[1]?.find(
      (row) => row.get("Package") === "zlib" && row.get("Version") === securityUpdate.version,
    );
    check(
      binary && source && binary.get("SHA256") === securityUpdate.binary,
      "Exact fixed zlib binary/source absent",
    );
    check(
      source.get("Checksums-Sha256")?.includes(securityUpdate.descriptor),
      "Fixed zlib descriptor drift",
    );
    // Absolute URLs prevent accidentally fetching the overlay from the old main snapshot.
    binary.set("Filename", `${securityUpdate.base}${binary.get("Filename")}`);
    source.set("Directory", `${securityUpdate.base}${source.get("Directory")}`);
    await writeFile(
      resolve(directory, "zlib-security-authentication.json"),
      `${JSON.stringify({ releaseSha256: sha256(await readFile(path)), signers, version: securityUpdate.version, binary: Object.fromEntries(binary), source: Object.fromEntries(source) }, null, 2)}\n`,
    );
    return { binary, source };
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

/** Reconstruct the effective authenticated quilt source without installing a host package. */
export async function reconstructZlibSource(output: string): Promise<void> {
  const effective = resolve(output, "zlib-effective");
  await rm(effective, { recursive: true, force: true });
  await mkdir(effective, { recursive: true });
  const source = resolve(output, "sources");
  execFileSync("tar", [
    "-xf",
    resolve(source, "zlib_1.3.dfsg+really1.3.1.orig.tar.gz"),
    "--strip-components=1",
    "-C",
    effective,
  ]);
  execFileSync("tar", [
    "-xf",
    resolve(source, "zlib_1.3.dfsg+really1.3.1-1+deb13u1.debian.tar.xz"),
    "-C",
    effective,
  ]);
  const series = (await readFile(resolve(effective, "debian/patches/series"), "utf8"))
    .split("\n")
    .map((line) => line.replace(/\s*#.*$/, "").trim())
    .filter(Boolean);
  const patches = [];
  for (const name of series) {
    check(/^[A-Za-z0-9._-]+\.patch$/.test(name), "Review changed quilt options or unsafe path");
    const path = resolve(effective, "debian/patches", name);
    // --directory keeps git's path checks; no fuzz, unsafe-path or rejected-hunk bypass.
    const relative = "apps/worker/dist/container/zlib-effective";
    const root = resolve(output, "../../../..");
    execFileSync("git", ["apply", "--check", `--directory=${relative}`, path], { cwd: root });
    execFileSync("git", ["apply", `--directory=${relative}`, path], { cwd: root });
    patches.push({ name, sha256: sha256(await readFile(path)) });
  }
  const patchedSources = Object.fromEntries(
    await Promise.all(
      ["crc32.c", "gzwrite.c"].map(async (name) => [
        name,
        sha256(await readFile(resolve(effective, name))),
      ]),
    ),
  );
  await writeFile(
    resolve(output, "zlib-effective.json"),
    `${JSON.stringify({ version: securityUpdate.version, descriptorSha256: securityUpdate.descriptor, patches, patchedSources, copyrightSha256: sha256(await readFile(resolve(effective, "debian/copyright"))) }, null, 2)}\n`,
  );
}
