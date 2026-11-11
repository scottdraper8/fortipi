export interface AssetManifest {
  schemaVersion: 1;
  packageVersion: string;
  sourceCommit: string;
  toolchain: { node: string; pnpm: string; wrangler: string; compiler: string };
  lockSha256: string;
  entry: string;
  files: {
    path: string;
    kind: "worker" | "contract" | "template" | "linux" | "license";
    size: number;
    sha256: string;
  }[];
}
