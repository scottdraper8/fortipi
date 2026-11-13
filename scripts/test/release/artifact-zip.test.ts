import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { readArtifactZip } from "../../artifact-zip.ts";

const windows = process.platform === "win32";
const execute = promisify(execFile);
async function powershell(script: string) {
  return execute(
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(`$ErrorActionPreference='Stop'; ${script}`, "utf16le").toString("base64"),
    ],
    {
      timeout: 30000,
      maxBuffer: 4_000_000,
      env: { SystemRoot: "C:\\Windows", PATH: "C:\\Windows\\System32", LANG: "C" },
    },
  );
}
const psValue = (value: string) =>
  `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(value).toString("base64")}'))`;
async function zip(directory: string, path: string, links = false) {
  if (windows) {
    await powershell(
      `[void][Reflection.Assembly]::LoadWithPartialName('System.IO.Compression.FileSystem'); [IO.Compression.ZipFile]::CreateFromDirectory(${psValue(directory)},${psValue(path)})`,
    );
  } else
    await execute("/usr/bin/zip", ["-q", ...(links ? ["-y"] : []), "-r", path, "."], {
      cwd: directory,
      timeout: 30000,
      maxBuffer: 4_000_000,
      env: { PATH: process.env.PATH, LANG: "C" },
    });
}
async function fixture() {
  const root = await mkdtemp(resolve(await realpath(tmpdir()), "fortipi-artifact-zip-"));
  const source = resolve(root, "source");
  await mkdir(source);
  return {
    root,
    source,
    path: resolve(root, "archive.zip"),
    close: () => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 }),
  };
}
/** A same-length filename fault in a real native ZIP, not a ZIP writer/parser. */
async function nameFault(path: string, from: string, to: string) {
  assert.equal(Buffer.byteLength(from), Buffer.byteLength(to));
  const bytes = await readFile(path);
  let at = 0,
    replaced = 0;
  for (;;) {
    const found = bytes.indexOf(from, at);
    if (found < 0) break;
    bytes.write(to, found);
    at = found + Buffer.byteLength(from);
    replaced++;
  }
  assert.equal(replaced, 2, "Expected local and central filename records only");
  await writeFile(path, bytes);
}

test("native ZIP returns exact selected bytes/names without extraction, including the 8MB member boundary", {
  timeout: 60000,
}, async () => {
  const f = await fixture();
  try {
    const bytes = Buffer.from('{"schemaVersion":1,"canary":"actual native zip"}\n');
    await writeFile(resolve(f.source, "candidate.json"), bytes);
    await mkdir(resolve(f.source, "nested"));
    await writeFile(resolve(f.source, "nested/other.txt"), "untouched");
    await zip(f.source, f.path);
    const result = await readArtifactZip(f.path, "candidate.json");
    assert.deepEqual(result.bytes, bytes);
    assert.deepEqual([...result.names].sort(), ["candidate.json", "nested/other.txt"]);
    await assert.rejects(readArtifactZip(f.path, "missing.json"));
    await assert.rejects(readArtifactZip(f.path, "*.json"), /Literal ZIP member/);
    await assert.rejects(readArtifactZip(f.path, "../candidate.json"), /Noncanonical ZIP path/);
    // The helper returns stdout only, never materializes ZIP entries in the caller directory.
    await assert.rejects(readFile(resolve(f.root, "candidate.json")), { code: "ENOENT" });
    await rm(f.path);
    await writeFile(resolve(f.source, "candidate.json"), Buffer.alloc(8_000_000, 97));
    await zip(f.source, f.path);
    assert.deepEqual(
      (await readArtifactZip(f.path, "candidate.json")).bytes,
      Buffer.alloc(8_000_000, 97),
    );
    await rm(f.path);
    await writeFile(resolve(f.source, "candidate.json"), Buffer.alloc(8_000_001, 97));
    await zip(f.source, f.path);
    await assert.rejects(readArtifactZip(f.path, "candidate.json"));
  } finally {
    await f.close();
  }
});

test("real ZIP duplicate/case/path faults and actual link metadata reject before any member is returned", {
  timeout: 60000,
}, async () => {
  for (const fault of ["duplicate", "case", "path", "link", "control-name", "caret-name"]) {
    const f = await fixture();
    try {
      await writeFile(resolve(f.source, "first.json"), "{}");
      const actualName =
        fault === "control-name"
          ? "bad\nname.json"
          : fault === "caret-name"
            ? "bad^Jname.json"
            : undefined;
      if (actualName && (!windows || fault !== "control-name"))
        await writeFile(resolve(f.source, actualName), "actual-name-canary");
      if (fault === "path") {
        await mkdir(resolve(f.source, "level"));
        await writeFile(resolve(f.source, "level/evil.json"), "public fixture");
      } else if (fault !== "link") await writeFile(resolve(f.source, "other.json"), "{}");
      if (fault === "link" && !windows) await symlink("first.json", resolve(f.source, "link"));
      await zip(f.source, f.path, fault === "link");
      if (fault === "control-name" && windows)
        await powershell(`
        [void][Reflection.Assembly]::LoadWithPartialName('System.IO.Compression.FileSystem');
        $z=[IO.Compression.ZipFile]::Open(${psValue(f.path)},[IO.Compression.ZipArchiveMode]::Update);
        try {$e=$z.CreateEntry(${psValue("bad\nname.json")});$s=$e.Open();try{$b=[Text.Encoding]::UTF8.GetBytes('actual-name-canary');$s.Write($b,0,$b.Length)}finally{$s.Dispose()}}finally{$z.Dispose()}`);
      if (actualName && !windows) {
        const actual = await execute("/usr/bin/unzip", ["-p", f.path, actualName], {
          timeout: 30000,
          env: { PATH: process.env.PATH, LANG: "C" },
        });
        assert.equal(
          actual.stdout,
          "actual-name-canary",
          "Oracle must use the actual member, not its native display alias",
        );
      }
      if (fault === "link" && windows)
        await powershell(`
        [void][Reflection.Assembly]::LoadWithPartialName('System.IO.Compression.FileSystem');
        $z=[IO.Compression.ZipFile]::Open(${psValue(f.path)},[IO.Compression.ZipArchiveMode]::Update);
        try {$e=$z.CreateEntry('link');$e.ExternalAttributes=(0xA1FF -shl 16);$s=$e.Open();try{$b=[Text.Encoding]::UTF8.GetBytes('first.json');$s.Write($b,0,$b.Length)}finally{$s.Dispose()}}finally{$z.Dispose()}`);
      if (fault === "duplicate") await nameFault(f.path, "other.json", "first.json");
      if (fault === "case") await nameFault(f.path, "other.json", "FIRST.json");
      if (fault === "path") await nameFault(f.path, "level/evil.json", "../../evil.json");
      if (actualName && !windows)
        await assert.rejects(
          readArtifactZip(f.path, "first.json"),
          /Ambiguous or nonportable ZIP member name/,
        );
      else await assert.rejects(readArtifactZip(f.path, "first.json"));
    } finally {
      await f.close();
    }
  }
});

test("actual ZIP count and name-output bounds are retained with no data extraction", {
  timeout: 180000,
}, async () => {
  const f = await fixture();
  try {
    await writeFile(resolve(f.source, "candidate.json"), "{}");
    for (let offset = 0; offset < 29999; offset += 100)
      await Promise.all(
        Array.from({ length: Math.min(100, 29999 - offset) }, (_, i) =>
          writeFile(resolve(f.source, `f${offset + i}.txt`), ""),
        ),
      );
    await zip(f.source, f.path);
    assert.equal((await readArtifactZip(f.path, "candidate.json")).names.length, 30000);
    await rm(f.path);
    await writeFile(resolve(f.source, "one-too-many.txt"), "");
    await zip(f.source, f.path);
    await assert.rejects(readArtifactZip(f.path, "candidate.json"));
  } finally {
    await f.close();
  }
  const n = await fixture();
  try {
    await writeFile(resolve(n.source, "candidate.json"), "{}");
    if (windows) {
      // .NET creates long member names without relying on legacy filesystem MAX_PATH behavior.
      await zip(n.source, n.path);
      await powershell(`[void][Reflection.Assembly]::LoadWithPartialName('System.IO.Compression.FileSystem');
        $z=[IO.Compression.ZipFile]::Open(${psValue(n.path)},[IO.Compression.ZipArchiveMode]::Update);
        try {for($i=0;$i -lt 3000;$i++){[void]$z.CreateEntry(('a'*1400)+$i+'.txt')}}finally{$z.Dispose()}`);
    } else {
      let deep = n.source;
      for (let depth = 0; depth < 5; depth++) {
        deep = resolve(deep, "a".repeat(140));
        await mkdir(deep);
      }
      for (let offset = 0; offset < 6000; offset += 100)
        await Promise.all(
          Array.from({ length: 100 }, (_, i) => writeFile(resolve(deep, `f${offset + i}.txt`), "")),
        );
      await zip(n.source, n.path);
    }
    await assert.rejects(readArtifactZip(n.path, "candidate.json"));
    await assert.rejects(readFile(resolve(n.root, "candidate.json")), { code: "ENOENT" });
  } finally {
    await n.close();
  }
});
