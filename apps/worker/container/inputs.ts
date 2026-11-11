/** Reviewed inputs; these digests identify inputs, never the final FortiPi image. */
export const imageInputs = {
  source: "bb0a5db4b7e8c8a79625d63e0e272602f909640e",
  sourceArchiveSha256: "b5ae608fd845af5762187793e0d823c414e37d5d98eb1e62ea406b1eabb326c6",
  embeddedNodeVersion: "22.23.4",
  embeddedNodeLicenseSha256: "c738ae413cf561f174e34f6961f8ca458aae2369a73640dda6234c629b98bcc4",
  computerVersion: "0.10.0",
  computerd:
    "ghcr.io/cloudflare/computer-computerd-linux-x64@sha256:6ec793fa80f109acf8b3cd4e295284cfed97f61c03030b780a612ec22c49b294",
  debian: "debian@sha256:7378260c0a098d27ac206225db5e7d92b8c7c84ea7afccc86eeb513756bbd392",
  snapshot: "20261110T000000Z",
  packages: { fuse3: "3.18.3-1", "libfuse3-4": "3.18.3-1", libfuse2t64: "2.9.9-9" },
  docker: "29.9.3",
  buildkit: "0.34.2",
} as const;
