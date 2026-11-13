import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { isAbsolute } from "node:path";

export interface ArtifactZipMember {
  /** Regular member names in archive order, with no extraction to the filesystem. */
  names: string[];
  bytes: Buffer;
}

const namesBound = 4_000_000;
const memberBound = 8_000_000;
function namePath(name: string): string {
  const local = name.replace(/\/$/, "");
  assert.ok(
    local &&
      !local.startsWith("/") &&
      !/^[A-Za-z]:/.test(local) &&
      [...local].every(
        (character) =>
          character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127 && character !== "\\",
      ) &&
      local.split("/").every((part) => part && part !== "." && part !== ".."),
    "Noncanonical ZIP path",
  );
  return local;
}
function listing(bytes: Buffer, member: string): { listed: string[]; names: string[] } {
  assert.ok(bytes.length <= namesBound);
  const text = bytes.toString("utf8");
  assert.equal(Buffer.from(text).equals(bytes), true, "Invalid ZIP name encoding");
  const listed = text.replace(/\r?\n$/, "").split(/\r?\n/);
  assert.ok(listed.length > 0 && listed.length <= 30000, "ZIP member count bound");
  const normalized = listed.map(namePath);
  assert.equal(
    new Set(normalized.map((name) => name.toLowerCase())).size,
    listed.length,
    "Duplicate normalized ZIP path",
  );
  const names = listed.filter((name) => !name.endsWith("/"));
  assert.ok(names.includes(member), "Metadata missing from actual archive");
  return { listed, names };
}

/** Fixed C:\\Windows inbox PowerShell bootstrap; not PATH/pwsh/tool-cache resolution.
 * Actual windows-2025 image/ACL/runtime qualification remains a GHA handoff. */
function windowsCommand(path: string, member: string, mode: "list" | "member"): string[] {
  const encoded = (value: string) => Buffer.from(value).toString("base64");
  const script = String.raw`
$ErrorActionPreference='Stop'
$PSModuleAutoLoadingPreference='None'
$ProgressPreference='SilentlyContinue'
try {
  Set-StrictMode -Version Latest
  if ($PSHOME -ne 'C:\Windows\System32\WindowsPowerShell\v1.0') { throw 'Unexpected system PowerShell' }
  $installer=([System.Security.Principal.NTAccount]::new('NT SERVICE','TrustedInstaller')).Translate([System.Security.Principal.SecurityIdentifier]).Value
  $owners=@('S-1-5-18','S-1-5-32-544',$installer)
  $write=[System.Security.AccessControl.FileSystemRights]::Write -bor [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [System.Security.AccessControl.FileSystemRights]::Delete -bor [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor [System.Security.AccessControl.FileSystemRights]::TakeOwnership
  foreach ($systemPath in @('C:\Windows','C:\Windows\System32','C:\Windows\System32\WindowsPowerShell',$PSHOME,($PSHOME+'\powershell.exe'))) {
    $attributes=[IO.File]::GetAttributes($systemPath)
    if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Linked system reader' }
    if (($attributes -band [IO.FileAttributes]::Directory) -ne 0) { $acl=[IO.Directory]::GetAccessControl($systemPath) } else { $acl=[IO.File]::GetAccessControl($systemPath) }
    if ($owners -notcontains $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value) { throw 'Untrusted system reader owner' }
    $raw=[System.Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(),0)
    if ($null -eq $raw.DiscretionaryAcl) { throw 'Unrestricted system reader ACL' }
    foreach ($rule in $acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])) {
      if (($rule.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0 -and $rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and ($rule.FileSystemRights -band $write) -ne 0 -and $owners -notcontains $rule.IdentityReference.Value) { throw 'Writable system reader' }
    }
  }
  [void][Reflection.Assembly]::LoadWithPartialName('System.IO.Compression')
  [void][Reflection.Assembly]::LoadWithPartialName('System.IO.Compression.FileSystem')
  if ($null -eq [IO.Compression.ZipArchiveEntry].GetProperty('ExternalAttributes')) { throw 'ZIP entry type inspection unavailable' }
  $zipPath=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded(path)}'))
  $member=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded(member)}'))
  $zip=[IO.Compression.ZipFile]::OpenRead($zipPath)
  try {
    if ($zip.Entries.Count -lt 1 -or $zip.Entries.Count -gt 30000) { throw 'ZIP member count bound' }
    $names=[System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $nameBytes=0L
    $selected=$null
    foreach ($entry in $zip.Entries) {
      $name=$entry.FullName
      $local=$name.TrimEnd('/')
      if ($local.Length -eq 0 -or $local.StartsWith('/') -or $local -match '^[A-Za-z]:' -or $local -match '[\x00-\x1f\x7f\\]' -or $local -match '(^|/)(\.|\.\.|)(/|$)') { throw 'Noncanonical ZIP path' }
      if (-not $names.Add($local)) { throw 'Duplicate normalized ZIP path' }
      $type=($entry.ExternalAttributes -shr 16) -band 0xF000
      if (@(0,0x4000,0x8000) -notcontains $type -or ($entry.ExternalAttributes -band 0x440) -ne 0) { throw 'ZIP links/special members rejected' }
      if (($entry.ExternalAttributes -band 0x10) -ne 0 -and -not $name.EndsWith('/')) { throw 'Noncanonical ZIP directory' }
      if ($type -eq 0x4000 -and -not $name.EndsWith('/')) { throw 'Noncanonical ZIP directory' }
      if ($type -eq 0x8000 -and $name.EndsWith('/')) { throw 'Noncanonical ZIP file' }
      $nameBytes += [Text.Encoding]::UTF8.GetByteCount($name)+1
      if ($nameBytes -gt 4000000) { throw 'ZIP name byte bound' }
      if ([String]::Equals($name,$member,[StringComparison]::Ordinal)) { $selected=$entry }
    }
    if ($null -eq $selected -or $selected.FullName.EndsWith('/') -or $selected.Length -gt 8000000) { throw 'ZIP selected member unavailable/bound' }
    $output=[Console]::OpenStandardOutput()
    if ('${mode}' -eq 'list') {
      foreach ($entry in $zip.Entries) { $data=[Text.Encoding]::UTF8.GetBytes($entry.FullName+[char]10); $output.Write($data,0,$data.Length) }
    } else {
      $stream=$selected.Open()
      try {
        $buffer=[byte[]]::new(65536)
        $total=0L
        while (($count=$stream.Read($buffer,0,$buffer.Length)) -gt 0) {
          $total+=$count
          if ($total -gt 8000000) { throw 'ZIP member byte bound' }
          $output.Write($buffer,0,$count)
        }
        if ($total -ne $selected.Length) { throw 'ZIP selected length mismatch' }
      } finally { $stream.Dispose() }
    }
    $output.Flush()
  } finally { $zip.Dispose() }
} catch { [Console]::Error.WriteLine('Native ZIP operation rejected'); exit 1 }
`;
  return [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64"),
  ];
}

/** Native ZIP transport only; caller owns artifact digest, common paths and payload closure. */
export async function readArtifactZip(path: string, member: string): Promise<ArtifactZipMember> {
  assert.ok(isAbsolute(path));
  namePath(member);
  assert.ok(
    !member.endsWith("/") && !/[*?[\]]/.test(member) && !member.startsWith("-"),
    "Literal ZIP member required",
  );
  const stat = await lstat(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1);
  const deadline = performance.now() + 60000;
  const run = async (
    tool: string,
    args: string[],
    maximum: number,
    env: NodeJS.ProcessEnv,
    cwd?: string,
  ): Promise<Buffer> => {
    const timeout = Math.min(30000, Math.floor(deadline - performance.now()));
    assert.ok(timeout > 0, "ZIP operation time bound");
    return new Promise((accept, reject) => {
      const child = execFile(
        tool,
        args,
        { timeout, maxBuffer: maximum, encoding: "buffer", env, cwd, windowsHide: true },
        (error, stdout) => {
          if (error) reject(new Error("Native ZIP operation unavailable or rejected"));
          else accept(stdout);
        },
      );
      child.stdin?.end();
    });
  };
  if (process.platform === "win32") {
    const tool = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
    const executable = await lstat(tool);
    assert.ok(
      executable.isFile() && !executable.isSymbolicLink(),
      "Trusted Windows ZIP reader unavailable",
    );
    const env = { SystemRoot: "C:\\Windows", PATH: "C:\\Windows\\System32", LANG: "C" };
    const listed = await run(
      tool,
      windowsCommand(path, member, "list"),
      namesBound,
      env,
      "C:\\Windows\\System32",
    );
    const { names } = listing(listed, member);
    const bytes = await run(
      tool,
      windowsCommand(path, member, "member"),
      memberBound,
      env,
      "C:\\Windows\\System32",
    );
    return { names, bytes };
  }
  const tool = "/usr/bin/unzip";
  const executable = await lstat(tool);
  assert.ok(
    executable.isFile() &&
      !executable.isSymbolicLink() &&
      executable.uid === 0 &&
      (executable.mode & 0o022) === 0 &&
      (executable.mode & 0o111) !== 0,
    "Trusted native ZIP reader unavailable",
  );
  const env = { PATH: process.env.PATH, LANG: "C" };
  const { listed, names } = listing(await run(tool, ["-Z1", path], namesBound, env), member);
  // Info-ZIP's native table supplies entry types/declared sizes, never a custom ZIP parser.
  const table = (await run(tool, ["-Z", "-l", path], namesBound, env))
    .toString("utf8")
    .split(/\r?\n/)
    .filter((line) => /^\S{10}\s+\d+\.\d+\s+\S+\s+\d+\s/.test(line));
  assert.equal(table.length, listed.length, "Uninspectable ZIP entry types");
  for (const [index, line] of table.entries()) {
    assert.ok(line.startsWith("-") || line.startsWith("d"), "ZIP links/special members rejected");
    assert.equal(line.startsWith("d"), listed[index]?.endsWith("/"));
    const fields = line.trim().split(/\s+/);
    assert.ok(!/^[BT]/.test(fields[4] ?? ""), "Encrypted ZIP member rejected");
  }
  const selected = table[listed.indexOf(member)]?.trim().split(/\s+/);
  assert.ok(selected && Number(selected[3]) <= memberBound, "ZIP member byte bound");
  const bytes = await run(tool, ["-p", path, member], memberBound, env);
  assert.equal(bytes.length, Number(selected[3]), "ZIP selected length mismatch");
  return { names, bytes };
}
