import { execFile } from "node:child_process";
import { createHash, createPublicKey, verify } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify, TextDecoder } from "node:util";
import { type Fields, paragraphs } from "./debian.ts";
import { imageInputs } from "./inputs.ts";

const exec = promisify(execFile);
export const sha256 = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
export function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
export async function run(program: string, args: string[]): Promise<Buffer> {
  const { stdout } = await exec(program, args, {
    encoding: "buffer",
    maxBuffer: 256 * 1024 * 1024,
    timeout: 120_000,
  });
  return stdout;
}
type Download = (url: string, expected?: string) => Promise<Uint8Array>;
const archiveSigner = "04B54C3CDCA79751B16BC6B5225629DF75B188BD";
const sourceSigner = "7D887DC8BA7BBBA7B835E3BADCE310E7864CC8BF";
const sourcePrimary = "A0DF7E0D3851E0EE45C00BC8ACE1F33CB933BBBB";
const baseLayer = "37fb86c2a767b88d500c6872195f88078f64765fe0d2f9cc375cc2efbd4c0a41";
const keyringHash = "506b815cbb32d9b6066b4a2aa524071e071761e7e7f68c3ac74f3061ba852017";
const sourcePublicSha256 = "e6d6acf96e7fbaa752d603fc43b5f96eea06045f53b9c4367a1864519eaff3c2";
const upstreamPublicSha256 = "68e9eab3bbb84a63cec0ca59eb82abb9cd1dee7059bce5bf92ca777f4186c7e0";
const sourceRevision = "3dbcfce64ba0dd529cec7b94305662e7901a991b";
const sourceFiles = {
  "util/fusermount.c": "c9b7c51a12d0af4dd9aa69dacf4b67f4e516e49ec206cd7e8d02d85d50610cf9",
  "lib/mount_util.c": "2701c6d7c347efbc165cc383e633a3dce281dd22bafe3ab8ecd97d65977ea803",
  "lib/mount.c": "76169fd096bc650e2217fd008d91e4d40aa13834fa6388b99b2cd8c1d8eda7fe",
  "lib/fuse_lowlevel.c": "f3c1690969963f9be772b0ef5775d20481152a2a3dd2c598413f45546ae74e9e",
};
const releases = {
  trixie: {
    inRelease: "0584fba32e13e0ab8285fb16c27adea1ec03a73669c18702821094fd6ca86675",
    release: "ed56aac47e7911e65ee63aae8d67e29f20e023f840e49f8ed037043a33de138a",
    packages: "7778d3e3f303b7ddb8ce0fe7c8d57473a076c6bf2e8f241f75421d2396352498",
    sources: "6002f81f463a2d976d84b34170367cc16da2d60bd0ba9ab9d868d6e1c1a935d9",
  },
  sid: {
    inRelease: "14eaf22bbbf0f806bd59a1afd96bee2afc5cecf00b34eed3c3f9d308ca66ca28",
    release: "d3b31f0c712c49f4c6d8d802bebaad394a1c3d1bb3244262f996494ddcfa3783",
    packages: "a1619d267517462de0021ee365a2b9590c5cc2bf5b03b3ebd78406ed6b408e44",
    sources: "451461c80cea225e9aaf961318c03709d88763ce1a5440d184cfe7e207130d7f",
  },
};
/** Parse authenticated cleartext only after gpgv succeeds. Preserve its final LF. */
export function cleartext(bytes: Uint8Array): string {
  const armor = new TextDecoder("utf8", { fatal: true }).decode(bytes).replaceAll("\r\n", "\n");
  check(
    armor.startsWith("-----BEGIN PGP SIGNED MESSAGE-----\n"),
    "Expected signed Debian metadata",
  );
  const begin = armor.indexOf("\n\n");
  const end = armor.indexOf("\n-----BEGIN PGP SIGNATURE-----", begin);
  check(begin > 0 && end > begin, "Malformed Debian signed metadata");
  return armor.slice(begin + 2, end + 1).replace(/^- /gm, "");
}
export async function verifySigned(
  path: string,
  keyring: string,
  home: string,
  primary: string,
  signer?: string,
): Promise<string> {
  const status = (
    await run("gpgv", ["--homedir", home, "--keyring", keyring, "--status-fd", "1", path])
  ).toString("utf8");
  check(
    status.split("\n").some((line) => {
      const fields = line.split(" ");
      return (
        fields[0] === "[GNUPG:]" &&
        fields[1] === "VALIDSIG" &&
        fields.at(-1) === primary &&
        (!signer || fields[2] === signer)
      );
    }),
    "Debian signature does not match the frozen signer",
  );
  return cleartext(await readFile(path));
}
/** Debian wraps the original two-line signify signature in PGP ARMORED FILE. */
export function verifyUpstream(archive: Uint8Array, armored: string, publicKey: string): void {
  const wrapper =
    /^-----BEGIN PGP ARMORED FILE-----\n(?:Comment: [^\n]*\n)?\n([A-Za-z0-9+/=\n]+)\n=[A-Za-z0-9+/]{4}\n-----END PGP ARMORED FILE-----\n?$/.exec(
      armored.replaceAll("\r\n", "\n"),
    );
  check(wrapper?.[1], "Unexpected upstream signature wrapper");
  const decode = (text: string, length: number) => {
    const lines = text.trim().split("\n");
    check(
      lines.length === 2 && lines[0]?.startsWith("untrusted comment: "),
      "Unexpected signify encoding",
    );
    const packet = Buffer.from(lines[1] ?? "", "base64");
    check(
      packet.length === length && packet.subarray(0, 2).toString() === "Ed",
      "Unexpected signify algorithm or length",
    );
    return packet;
  };
  const signature = decode(
    Buffer.from(wrapper[1].replaceAll("\n", ""), "base64").toString("utf8"),
    74,
  );
  const key = decode(publicKey, 42);
  check(
    key.subarray(2, 10).equals(signature.subarray(2, 10)),
    "Upstream signify key identity mismatch",
  );
  const spki = createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), key.subarray(10)]),
    format: "der",
    type: "spki",
  });
  check(
    verify(null, archive, spki, signature.subarray(10)),
    "Upstream FUSE archive signature mismatch",
  );
}
export interface AuthenticatedIndexes {
  packages: Fields[];
  sources: Fields[];
  fusePackages: Fields[];
  fuseSource: Fields;
  releaseSha256: string;
  packagesIndexSha256: string;
  sourcesIndexSha256: string;
  fuseReleaseSha256: string;
  fusePackagesIndexSha256: string;
  fuseSourcesIndexSha256: string;
}
/** Only two SID roots are admitted; all unrelated dependencies retain the frozen base/index. */
export async function authenticateIndexes(
  download: Download,
  output: string,
): Promise<AuthenticatedIndexes> {
  check(
    imageInputs.snapshot === "20261110T000000Z",
    "Review signatures when changing the dated snapshot",
  );
  const destination = resolve(output, "security");
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  const home = await mkdtemp(resolve(output, "gpgv-"));
  try {
    const layer = resolve(output, `${baseLayer}.tgz`);
    check(sha256(await readFile(layer)) === baseLayer, "Debian trust bootstrap layer mismatch");
    const publicKeyring = await run("tar", [
      "-xOf",
      layer,
      "usr/share/keyrings/debian-archive-keyring.pgp",
    ]);
    check(sha256(publicKeyring) === keyringHash, "Debian archive public keyring mismatch");
    const keyring = resolve(destination, "archive-keyring.pgp");
    await writeFile(keyring, publicKeyring);
    const base = `https://snapshot.debian.org/archive/debian/${imageInputs.snapshot}/`;
    const indexes = await Promise.all(
      Object.entries(releases).map(async ([suite, pins]) => {
        const path = resolve(destination, `${suite}.InRelease`);
        await writeFile(path, await download(`${base}dists/${suite}/InRelease`, pins.inRelease));
        const release = await verifySigned(path, keyring, home, archiveSigner);
        check(sha256(release) === pins.release, "Debian authenticated Release drift");
        const fields = paragraphs(release)[0];
        check(
          fields?.get("Suite") === (suite === "sid" ? "unstable" : "stable"),
          "Wrong Debian suite",
        );
        const checksums = (fields.get("SHA256") ?? "")
          .trim()
          .split("\n")
          .map((line) => line.trim().split(/\s+/));
        const [packages, sources] = await Promise.all(
          [
            ["main/binary-amd64/Packages.xz", pins.packages],
            ["main/source/Sources.xz", pins.sources],
          ].map(async ([name, expected]) => {
            check(name && expected, "Missing index pin");
            const row = checksums.find((row) => row[2] === name);
            check(row?.[0] === expected, "Index is not authenticated by the pinned Release");
            const bytes = await download(`${base}dists/${suite}/${name}`, expected);
            check(bytes.length === Number(row[1]), "Authenticated index size mismatch");
            const path = resolve(destination, `${suite}-${name.replaceAll("/", "-")}`);
            await writeFile(path, bytes);
            return paragraphs(
              (await run("xz", ["--decompress", "--stdout", path])).toString("utf8"),
            );
          }),
        );
        check(packages && sources, "Missing authenticated indexes");
        return { suite, packages, sources };
      }),
    );
    const trixie = indexes.find((item) => item.suite === "trixie");
    const sid = indexes.find((item) => item.suite === "sid");
    check(trixie && sid, "Missing Debian release");
    const fusePackages = ["fuse3", "libfuse3-4"].map((name) => {
      const row = sid.packages.find(
        (row) =>
          row.get("Package") === name &&
          row.get("Version") === "3.18.3-1" &&
          row.get("Architecture") === "amd64",
      );
      check(row, "Secure FUSE binary is missing from authenticated SID index");
      return row;
    });
    const fuseSource = sid.sources.find(
      (row) => row.get("Package") === "fuse3" && row.get("Version") === "3.18.3-1",
    );
    check(fuseSource, "Secure FUSE source missing from authenticated SID index");
    const files = (fuseSource.get("Checksums-Sha256") ?? "")
      .trim()
      .split("\n")
      .map((line) => {
        const [hash, size, name] = line.trim().split(/\s+/);
        check(
          hash && name && /^[a-f0-9]{64}$/.test(hash) && /^fuse3_[A-Za-z0-9.+-]+$/.test(name),
          "Invalid authenticated FUSE source",
        );
        return { hash, size: Number(size), name };
      });
    check(
      files.length === 4 && fuseSource.get("Directory") === "pool/main/f/fuse3",
      "Unexpected FUSE source closure",
    );
    const sourceBytes = new Map<string, Uint8Array>();
    await Promise.all(
      files.map(async (file) => {
        const bytes = await download(
          `${base}${fuseSource.get("Directory")}/${file.name}`,
          file.hash,
        );
        check(bytes.length === file.size, "FUSE source size mismatch");
        sourceBytes.set(file.name, bytes);
      }),
    );
    const descriptor = resolve(destination, "fuse3_3.18.3-1.dsc");
    const dsc = sourceBytes.get("fuse3_3.18.3-1.dsc");
    check(dsc, "Missing signed FUSE descriptor");
    await writeFile(descriptor, dsc);
    const sourceKey = await download(
      `https://keyring.debian.org/pks/lookup?op=get&search=0x${sourceSigner}`,
      sourcePublicSha256,
    );
    await writeFile(resolve(destination, "debian-source-signer-response.html"), sourceKey);
    const response = new TextDecoder().decode(sourceKey).replaceAll("\r\n", "\n");
    const begin = response.indexOf("-----BEGIN PGP PUBLIC KEY BLOCK-----");
    const end = response.indexOf("-----END PGP PUBLIC KEY BLOCK-----", begin);
    check(begin >= 0 && end > begin, "Missing Debian public key block");
    const armor = response.slice(begin, end + "-----END PGP PUBLIC KEY BLOCK-----".length);
    await writeFile(resolve(destination, "debian-source-signer.asc"), `${armor}\n`);
    const payload = armor.slice(armor.indexOf("\n\n") + 2, armor.indexOf("\n="));
    check(
      armor.startsWith("-----BEGIN PGP PUBLIC KEY BLOCK-----") && payload.length > 0,
      "Invalid Debian public key armor",
    );
    const sourceKeyring = resolve(destination, "debian-source-signer.pgp");
    const keyBytes = Buffer.from(payload.replaceAll("\n", ""), "base64");
    check(
      sha256(keyBytes) === "38ead01d85cc57fd75a07c1ea4ffcad736be6fb4c006f0cf7f029dda1472041f",
      "Debian source public key mismatch",
    );
    await writeFile(sourceKeyring, keyBytes);
    const signedSource = paragraphs(
      await verifySigned(descriptor, sourceKeyring, home, sourcePrimary, sourceSigner),
    )[0];
    check(
      signedSource?.get("Source") === "fuse3" && signedSource.get("Version") === "3.18.3-1",
      "Signed FUSE source identity mismatch",
    );
    for (const file of files.filter((file) => !file.name.endsWith(".dsc")))
      check(
        (signedSource.get("Checksums-Sha256") ?? "").split("\n").some((line) => {
          const [hash, size, name] = line.trim().split(/\s+/);
          return hash === file.hash && Number(size) === file.size && name === file.name;
        }),
        "FUSE source is not bound by the signed DSC",
      );
    const upstreamKey = await download(
      `https://raw.githubusercontent.com/libfuse/libfuse/${sourceRevision}/signify/fuse-3.18.pub`,
      upstreamPublicSha256,
    );
    await writeFile(resolve(destination, "fuse-3.18.pub"), upstreamKey);
    const orig = sourceBytes.get("fuse3_3.18.3.orig.tar.gz");
    const signature = sourceBytes.get("fuse3_3.18.3.orig.tar.gz.asc");
    check(orig && signature, "Missing upstream FUSE signature inputs");
    verifyUpstream(
      orig,
      new TextDecoder().decode(signature),
      new TextDecoder().decode(upstreamKey),
    );
    const archive = resolve(destination, "fuse3_3.18.3.orig.tar.gz");
    await writeFile(archive, orig);
    for (const [path, expected] of Object.entries(sourceFiles))
      check(
        sha256(await run("tar", ["-xOf", archive, `fuse-3.18.3/${path}`])) === expected,
        "FUSE security source differs from reviewed official tag",
      );
    const packaging = sourceBytes.get("fuse3_3.18.3-1.debian.tar.xz");
    check(packaging, "Missing authenticated FUSE packaging");
    const packagingPath = resolve(destination, "fuse3_3.18.3-1.debian.tar.xz");
    await writeFile(packagingPath, packaging);
    const entries = (await run("tar", ["-tf", packagingPath]))
      .toString("utf8")
      .trim()
      .split("\n")
      .map((name) => name.replace(/^\.\//, ""));
    check(
      entries.every((name) => name.startsWith("debian/") && !name.split("/").includes("..")) &&
        !entries.includes("debian/patches/series"),
      "FUSE packaging can change the reviewed upstream security sources",
    );
    // Raw signatures/keys/indexes ship with the kit; no derived success is accepted on a later run.
    await writeFile(
      resolve(destination, "verification.json"),
      `${JSON.stringify({ snapshot: imageInputs.snapshot, releases, archiveSigner, keyringHash, sourceSigner, sourcePrimary, sourcePublicSha256, upstreamPublicSha256, sourceRevision, sourceFiles, sourceFilesSha256: files }, null, 2)}\n`,
    );
    return {
      packages: trixie.packages,
      sources: trixie.sources,
      fusePackages,
      fuseSource,
      releaseSha256: releases.trixie.release,
      packagesIndexSha256: releases.trixie.packages,
      sourcesIndexSha256: releases.trixie.sources,
      fuseReleaseSha256: releases.sid.release,
      fusePackagesIndexSha256: releases.sid.packages,
      fuseSourcesIndexSha256: releases.sid.sources,
    };
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
