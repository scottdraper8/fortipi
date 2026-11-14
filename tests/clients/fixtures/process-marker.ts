import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { open, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

async function main() {
  const [marker, nonce, mode, ...values] = process.argv.slice(2);
  assert.ok(
    marker &&
      nonce &&
      ["once", "tree", "descendant", "workspace", "edit", "output"].includes(mode ?? ""),
  );
  assert.ok(
    !Object.keys(process.env).some((key) => /TOKEN|SECRET|CLOUDFLARE|NPM_/i.test(key)),
    "Child received an unrelated credential role",
  );
  const file = await open(marker, "a", 0o600);
  try {
    await file.writeFile(`${nonce}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  if (mode === "workspace") {
    const multi = Buffer.alloc(2 * 1024 * 1024);
    let value = 1010 & 255;
    for (let index = 0; index < multi.length; index++) {
      multi[index] = value;
      value = (value + 31) & 255;
    }
    for (const [name, bytes] of Object.entries({
      "notes.txt": Buffer.from("old-v1\n"),
      "binary.bin": Buffer.from("00ff0d0a8001", "hex"),
      "multi.bin": multi,
    })) {
      const output = await open(name, "wx", 0o600);
      try {
        await output.writeFile(bytes);
        await output.sync();
      } finally {
        await output.close();
      }
    }
  }
  if (mode === "edit") {
    const [before, after] = values;
    assert.ok(before && after);
    assert.equal(
      await readFile("notes.txt", "utf8"),
      `${before}\n`,
      "Fresh native execution must materialize the actual committed cloud base",
    );
    const output = await open("notes.txt", "w");
    try {
      await output.writeFile(`${after}\n`);
      await output.sync();
    } finally {
      await output.close();
    }
  }
  if (mode === "descendant") {
    await writeFile(`${marker}.ready`, JSON.stringify({ pid: process.pid, nonce }), {
      mode: 0o600,
    });
    setInterval(() => {
      void readFile(`${marker}.stop`, "utf8")
        .then((value) => {
          if (value === nonce) process.exit(0);
        })
        .catch(() => {});
    }, 250);
    setTimeout(() => process.exit(2), 45000);
    return;
  }
  let descendant: number | undefined;
  if (mode === "tree") {
    const child = spawn(
      process.execPath,
      [resolve(import.meta.filename), `${marker}.child`, nonce, "descendant"],
      { env: process.env, stdio: "ignore" },
    );
    assert.ok(child.pid);
    descendant = child.pid;
  }
  if (mode === "output") {
    process.stdout.write("\u03bb".repeat(8192));
    return;
  }
  process.stdout.write(
    `${JSON.stringify({ nonce, pid: process.pid, ...(descendant ? { descendant } : {}), values, nativeTty: !!process.stdout.isTTY })}\n`,
  );
  if (mode === "tree") setInterval(() => {}, 1000);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  void main().catch(() => {
    process.exitCode = 1;
  });
