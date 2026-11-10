// Keep canonical requirements unchanged throughout the build.
import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = await readFile(resolve(root, ".agent-docs/source-integrity.sha256"), "utf8");
let failed = false;

for (const line of manifest.trimEnd().split("\n")) {
  const delimiter = line.indexOf("  ");
  const expected = line.slice(0, delimiter);
  const name = line.slice(delimiter + 2);
  if (delimiter < 0 || !/^[a-f0-9]{64}$/.test(expected) || !name) {
    throw new Error("Invalid canonical source integrity manifest");
  }
  try {
    const path = await realpath(resolve(root, name));
    const withinRoot = relative(root, path);
    if (withinRoot === ".." || withinRoot.startsWith(`..${sep}`) || isAbsolute(withinRoot)) {
      throw new Error("Canonical source is outside the repository");
    }
    if (!(await stat(path)).isFile()) throw new Error("Canonical source is not a file");
    const actual = createHash("sha256").update(await readFile(path)).digest("hex");
    if (actual !== expected) throw new Error("Canonical source changed");
  } catch {
    console.error(`Canonical source missing, invalid, or changed: ${JSON.stringify(name)}`);
    failed = true;
  }
}

process.exitCode = Number(failed);
