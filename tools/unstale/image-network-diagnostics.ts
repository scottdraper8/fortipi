import { execFileSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { repository } from "../../scripts/build-workspaces.ts";

// CI preload: retain only a hostname and transport error code, never URLs/headers/credentials.
const fetchInput = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  try {
    return await fetchInput(input, init);
  } catch (error) {
    const address = input instanceof Request ? input.url : input.toString();
    const cause = error instanceof Error ? error.cause : undefined;
    const code =
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      typeof cause.code === "string" &&
      /^[A-Z0-9_]{1,40}$/.test(cause.code)
        ? cause.code
        : "unknown";
    console.error(`Image input network failure: ${new URL(address).hostname} (${code})`);
    throw error;
  }
};

const sha256 = (value: unknown): string | null =>
  typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value) ? value : null;

export function metadataDigests(value: unknown) {
  const fields = typeof value === "object" && value !== null ? value : {};
  const descriptor =
    "containerimage.descriptor" in fields ? fields["containerimage.descriptor"] : undefined;
  const observed = (object: object, key: string) => ({
    present: Object.hasOwn(object, key),
    digest: sha256(Reflect.get(object, key)),
  });
  return {
    "containerimage.digest": observed(fields, "containerimage.digest"),
    "containerimage.config.digest": observed(fields, "containerimage.config.digest"),
    "containerimage.descriptor.digest": observed(
      typeof descriptor === "object" && descriptor !== null ? descriptor : {},
      "digest",
    ),
  };
}

if (
  process.platform === "linux" &&
  process.argv[1] === resolve(repository, "apps/worker/container/build.ts")
) {
  process.once("beforeExit", async () => {
    let metadata: unknown;
    let loadedImageId: string | null = null;
    let metadataReadable = false;
    try {
      const path = resolve(repository, "apps/worker/dist/container/buildx-metadata.json");
      if ((await stat(path)).size <= 1_048_576) {
        metadata = JSON.parse(await readFile(path, "utf8"));
        metadataReadable = true;
      }
    } catch {
      // Missing/invalid diagnostic input cannot replace the original build failure.
    }
    try {
      loadedImageId = sha256(
        execFileSync(
          "docker",
          ["image", "inspect", "fortipi-computerd:verified", "--format", "{{.Id}}"],
          {
            encoding: "utf8",
            timeout: 10_000,
            killSignal: "SIGKILL",
            maxBuffer: 4096,
            stdio: ["ignore", "pipe", "ignore"],
            env: {
              HOME: process.env.HOME,
              PATH: process.env.PATH,
              DOCKER_HOST: process.env.DOCKER_HOST,
              DOCKER_CONFIG: process.env.DOCKER_CONFIG,
            },
          },
        ).trim(),
      );
    } catch {
      // Report only validated identity, never command errors or daemon details.
    }
    console.error(
      JSON.stringify({
        probe: "image-build-digests",
        metadataReadable,
        ...metadataDigests(metadata),
        loadedImageId,
      }),
    );
  });
}
