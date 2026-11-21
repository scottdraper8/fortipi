/** Portable relative artifact path; never interpret URL or shell escaping. */
export const assetPath = (path: string): boolean =>
  typeof path === "string" &&
  /^[A-Za-z0-9_./+@%~-]+$/.test(path) &&
  path
    .split("/")
    .every(
      (part) =>
        part &&
        part !== "." &&
        part !== ".." &&
        !part.endsWith(".") &&
        !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
    );

export interface AssetManifest {
  schemaVersion: 1;
  packageVersion: string;
  sourceCommit: string;
  toolchain: { node: string; pnpm: string; wrangler: string; compiler: string };
  lockSha256: string;
  entry: string;
  image?: {
    sourceCommit: string;
    imageId: string;
    builtManifestDigest: string;
    registryDigest: null;
    platform: "linux/amd64";
    metadataSha256: string;
    contextInventorySha256: string;
  };
  files: {
    path: string;
    kind: "worker" | "contract" | "template" | "linux" | "license";
    size: number;
    sha256: string;
  }[];
}
