import { type ChildProcessWithoutNullStreams, execFile, spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { userInfo } from "node:os";
import { isAbsolute, resolve, win32 } from "node:path";
import { promisify } from "node:util";
import type { PlatformAdapter } from "./types.js";

const exec = promisify(execFile);
function systemFile(relative: string): string {
  const root = process.env.SystemRoot;
  if (!root || !isAbsolute(root) || !/^[a-z]:\\windows$/i.test(root))
    throw new Error("untrusted SystemRoot");
  return win32.join(root, "System32", relative);
}
export function powershellArgs(command: string): string[] {
  return [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(command, "utf16le").toString("base64"),
  ];
}
/** Fixed OS utility startup paths; never inherit provider/app credentials or user module search paths. */
export function windowsUtilityEnvironment(): Record<string, string> {
  const executable = systemFile("WindowsPowerShell\\v1.0\\powershell.exe"),
    psHome = win32.dirname(executable),
    root = win32.dirname(win32.dirname(psHome)),
    home = userInfo().homedir;
  // psHome is <SystemRoot>/System32/WindowsPowerShell/v1.0; derive SystemRoot from the trusted executable.
  const systemRoot = win32.dirname(root),
    local = win32.join(home, "AppData", "Local");
  return {
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    USERPROFILE: home,
    LOCALAPPDATA: local,
    APPDATA: win32.join(home, "AppData", "Roaming"),
    TEMP: win32.join(local, "Temp"),
    TMP: win32.join(local, "Temp"),
    PATH: [win32.join(systemRoot, "System32"), systemRoot, psHome].join(";"),
    PSModulePath: win32.join(psHome, "Modules"),
  };
}
function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
async function ps(command: string): Promise<string> {
  const pending = exec(
    systemFile("WindowsPowerShell\\v1.0\\powershell.exe"),
    powershellArgs(`$ErrorActionPreference='Stop';${command}`),
    {
      windowsHide: true,
      timeout: 10000,
      maxBuffer: 65536,
      env: windowsUtilityEnvironment(),
    },
  );
  pending.child.stdin?.on("error", () => {});
  pending.child.stdin?.end(); // Public ChildProcess API: PowerShell must receive EOF on redirected stdin.
  let stdout: string;
  try {
    ({ stdout } = await pending);
  } catch (error) {
    const e = error as { code?: string | number; signal?: string; killed?: boolean };
    throw new Error(
      `Windows permission utility failed (code=${e.code ?? "unknown"}, signal=${e.signal ?? "none"}, killed=${e.killed === true})`,
    );
  }
  return stdout.trim();
}
// Every request reads current OS attributes. Reusing the fixed BCL reader avoids
// starting PowerShell for every pre/post filesystem check; no attribute is cached.
const attributeProgram = `$ErrorActionPreference='Stop';while($null -ne ($line=[Console]::ReadLine())){$parts=$line.Split(':',2);if($parts.Length -ne 2 -or $parts[0] -notmatch '^[0-9]{1,16}$'){break};$id=$parts[0];try{$p=[System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($parts[1]));$a=[int][System.IO.File]::GetAttributes($p);[Console]::Out.WriteLine($id+':'+$a.ToString([System.Globalization.CultureInfo]::InvariantCulture))}catch{[Console]::Out.WriteLine($id+':error')};[Console]::Out.Flush()}`;
/** Internal OS utility; the native probe observes its actual child for crash/EOF controls. */
export class WindowsAttributeReader {
  private readonly started: ((child: ChildProcessWithoutNullStreams) => void) | undefined;
  constructor(started?: (child: ChildProcessWithoutNullStreams) => void) {
    this.started = started;
  }
  private child: ChildProcessWithoutNullStreams | undefined;
  private sequence = 0;
  private buffer = "";
  private idle?: NodeJS.Timeout;
  private pending = new Map<
    number,
    {
      resolve: (attributes: number) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private fail(child: ChildProcessWithoutNullStreams, message: string): void {
    if (this.child !== child) return;
    this.child = undefined;
    clearTimeout(this.idle);
    this.buffer = "";
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(message));
    }
    this.pending.clear();
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
    child.kill();
  }
  private idleClose(child: ChildProcessWithoutNullStreams): void {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => {
      if (this.child !== child || this.pending.size) return;
      this.child = undefined;
      this.buffer = "";
      child.stdin.end(); // Actual EOF lets the fixed reader exit normally.
      const reap = setTimeout(() => child.kill(), 1000);
      child.once("close", () => clearTimeout(reap));
    }, 100);
  }
  private start(): ChildProcessWithoutNullStreams {
    const child = spawn(
      systemFile("WindowsPowerShell\\v1.0\\powershell.exe"),
      powershellArgs(attributeProgram),
      { windowsHide: true, env: windowsUtilityEnvironment(), stdio: "pipe" },
    );
    this.child = child;
    this.sequence = 0;
    let stderrBytes = 0;
    const failed = () => this.fail(child, "Windows attribute reader exited or failed");
    child.on("error", failed);
    child.on("close", failed);
    child.stdin.on("error", failed);
    child.stdout.on("error", failed);
    child.stdout.on("end", failed);
    child.stderr.on("error", failed);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (data: string) => {
      if (this.child !== child) return;
      this.buffer += data;
      if (this.buffer.length > 8192) {
        this.fail(child, "Windows attribute reply exceeded bound");
        return;
      }
      let end = this.buffer.indexOf("\n");
      while (end !== -1) {
        const line = this.buffer.slice(0, end).replace(/\r$/, "");
        this.buffer = this.buffer.slice(end + 1);
        const match = /^(\d{1,16}):(-?\d{1,10}|error)$/.exec(line);
        const request = match && this.pending.get(Number(match[1]));
        if (!match || !request) {
          this.fail(child, "Windows attribute reply correlation failed");
          return;
        }
        const attributes = Number(match[2]);
        if (match[2] !== "error" && (attributes < -2147483648 || attributes > 2147483647)) {
          this.fail(child, "Windows attribute reply value exceeded bound");
          return;
        }
        this.pending.delete(Number(match[1]));
        clearTimeout(request.timer);
        if (match[2] === "error") request.reject(new Error("Windows attribute query failed"));
        else request.resolve(attributes);
        end = this.buffer.indexOf("\n");
      }
      if (!this.pending.size) this.idleClose(child);
    });
    child.stderr.on("data", (data: Buffer) => {
      stderrBytes += data.length;
      if (stderrBytes > 65536) this.fail(child, "Windows attribute diagnostic exceeded bound");
    });
    try {
      this.started?.(child);
    } catch {
      this.fail(child, "Windows attribute observer failed");
      throw new Error("Windows attribute observer failed");
    }
    return child;
  }
  query(path: string): Promise<number> {
    if (!path.isWellFormed() || path.includes("\0"))
      return Promise.reject(new Error("Windows attribute path is invalid"));
    if (Buffer.byteLength(path, "utf8") > 131072)
      return Promise.reject(new Error("Windows attribute path exceeds bound"));
    // Resolve in the caller's current cwd, never the persistent helper's old cwd.
    path = resolve(path);
    if (!path.isWellFormed()) return Promise.reject(new Error("Windows attribute path is invalid"));
    if (Buffer.byteLength(path, "utf8") > 131072)
      return Promise.reject(new Error("Windows attribute path exceeds bound"));
    if (this.pending.size >= 64) return Promise.reject(new Error("Windows attribute reader busy"));
    clearTimeout(this.idle);
    const child = this.child ?? this.start(),
      id = ++this.sequence;
    if (!Number.isSafeInteger(id)) {
      this.fail(child, "Windows attribute sequence exhausted");
      return Promise.reject(new Error("Windows attribute sequence exhausted"));
    }
    return new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => this.fail(child, "Windows attribute query timed out"), 10000);
      this.pending.set(id, { resolve, reject, timer });
      // Only base64 path data enters stdin. No caller text is executable PowerShell.
      try {
        child.stdin.write(`${id}:${Buffer.from(path, "utf8").toString("base64")}\n`);
      } catch {
        this.fail(child, "Windows attribute reader write failed");
      }
    });
  }
}
const attributeReader = new WindowsAttributeReader();
interface Dacl {
  owner: string;
  me: string;
  tokenOwner: string;
  protected: boolean;
  rules: { sid: string; allow: boolean; rights: number }[];
}
async function inspectDacl(path: string, directory: boolean): Promise<Dacl> {
  return JSON.parse(
    await ps(
      `$a=[System.IO.${directory ? "Directory" : "File"}]::GetAccessControl(${literal(path)},[System.Security.AccessControl.AccessControlSections]'Owner,Access');$identity=[System.Security.Principal.WindowsIdentity]::GetCurrent();$me=$identity.User.Value;$b=[System.Text.StringBuilder]::new();[void]$b.Append('{"owner":"'+$a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value+'","me":"'+$me+'","tokenOwner":"'+$identity.Owner.Value+'","protected":'+$a.AreAccessRulesProtected.ToString().ToLowerInvariant()+',"rules":[');$sep='';foreach($r in $a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])){[void]$b.Append($sep+'{"sid":"'+$r.IdentityReference.Value+'","allow":'+($r.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow).ToString().ToLowerInvariant()+',"rights":'+([int64]$r.FileSystemRights).ToString([System.Globalization.CultureInfo]::InvariantCulture)+'}');$sep=','};[void]$b.Append(']}');[Console]::Out.Write($b.ToString())`,
    ),
  ) as Dacl;
}
/** Only SQLite sidecars under an already protected database/parent may tighten a token-default owner. */
export async function verifyWindowsSqliteSidecar(
  databasePath: string,
  suffix: "-journal" | "-wal" | "-shm",
): Promise<void> {
  if (!databasePath.endsWith(".sqlite") || !["-journal", "-wal", "-shm"].includes(suffix))
    throw new Error("invalid SQLite sidecar identity");
  const path = `${databasePath}${suffix}`,
    parent = win32.dirname(databasePath),
    platform = windows();
  const before = await lstat(path);
  if (!before.isFile() || before.nlink !== 1) throw new Error("unsafe SQLite sidecar type/link");
  await platform.verifyProtection(parent, true);
  await platform.verifyProtection(databasePath, false);
  if ((await realpath(parent)) !== resolve(parent)) throw new Error("SQLite parent alias");
  const parentBefore = await lstat(parent);
  await platform.verifyEntry(path, before);
  if ((await realpath(path)) !== resolve(path)) throw new Error("SQLite sidecar alias");
  const dacl = await inspectDacl(path, false);
  if (
    !dacl.rules.some((r) => r.sid === dacl.me && r.allow && (r.rights & 2032127) === 2032127) ||
    dacl.rules.some((r) => !r.allow || ![dacl.me, "S-1-5-18"].includes(r.sid))
  )
    throw new Error("unsafe SQLite sidecar rules; no hardening performed");
  if (dacl.owner !== dacl.me) {
    const subjects = new Set([dacl.me, "S-1-5-18"]);
    if (
      dacl.owner !== dacl.tokenOwner ||
      dacl.protected ||
      dacl.rules.length !== subjects.size ||
      dacl.rules.some((r) => !r.allow || !subjects.has(r.sid) || r.rights !== 2032127) ||
      [...subjects].some((sid) => !dacl.rules.some((r) => r.sid === sid))
    )
      throw new Error("unsafe SQLite sidecar owner or rules; no hardening performed");
    // Repeat the eligibility checks in the same bounded process that writes security metadata.
    // No permission is granted to another SID, and bytes are never read by SQLite before this returns.
    await ps(
      `$p=${literal(path)};$parent=${literal(parent)};$identity=[System.Security.Principal.WindowsIdentity]::GetCurrent();$sid=$identity.User;$system='S-1-5-18';$pa=[System.IO.Directory]::GetAccessControl($parent,[System.Security.AccessControl.AccessControlSections]'Owner,Access');if(!$pa.AreAccessRulesProtected -or $pa.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value){throw 'SQLite parent protection changed'};$userControl=$false;foreach($r in $pa.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])){if($r.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or ($r.IdentityReference.Value -ne $sid.Value -and $r.IdentityReference.Value -ne $system)){throw 'SQLite parent rules changed'};if($r.IdentityReference.Value -eq $sid.Value -and (([int64]$r.FileSystemRights -band 2032127) -eq 2032127)){$userControl=$true}};if(!$userControl -or (([int][System.IO.File]::GetAttributes($p) -band 1024) -ne 0)){throw 'SQLite sidecar protection changed'};$a=[System.IO.File]::GetAccessControl($p,[System.Security.AccessControl.AccessControlSections]'Owner,Access');if($a.AreAccessRulesProtected -or $a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $identity.Owner.Value){throw 'SQLite sidecar owner changed'};$rules=$a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]);$expected=if($sid.Value -eq $system){1}else{2};if($rules.Count -ne $expected){throw 'SQLite sidecar rules changed'};$seenUser=$false;$seenSystem=$false;foreach($r in $rules){$s=$r.IdentityReference.Value;if($r.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or ($s -ne $sid.Value -and $s -ne $system) -or [int64]$r.FileSystemRights -ne 2032127){throw 'SQLite sidecar rules changed'};if($s -eq $sid.Value){$seenUser=$true};if($s -eq $system){$seenSystem=$true}};if(!$seenUser -or !$seenSystem){throw 'SQLite sidecar rules changed'};$a.SetAccessRuleProtection($true,$true);$a.SetOwner($sid);[System.IO.File]::SetAccessControl($p,$a)`,
    );
  }
  const after = await lstat(path),
    parentAfter = await lstat(parent);
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    after.nlink !== 1 ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    parentBefore.dev !== parentAfter.dev ||
    parentBefore.ino !== parentAfter.ino
  )
    throw new Error("SQLite sidecar replacement or content change");
  await platform.verifyProtection(parent, true);
  await platform.verifyProtection(databasePath, false);
  await platform.verifyProtection(path, false);
}
export function windows(): PlatformAdapter {
  return {
    platform: "win32",
    confinement: "host",
    async protect(path, directory) {
      const type = directory ? "DirectorySecurity" : "FileSecurity";
      await ps(
        // Windows PowerShell runs on .NET Framework. Typed SID overloads avoid account-name resolution;
        // direct BCL calls do not depend on Security/Management/Utility cmdlet module autoload.
        `$p=${literal(path)};$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User;$acl=[System.Security.AccessControl.${type}]::new();$acl.SetOwner($sid);$acl.SetAccessRuleProtection($true,$false);$flags=[System.Security.AccessControl.InheritanceFlags]${directory ? "'ContainerInherit,ObjectInherit'" : "'None'"};foreach($s in @($sid,[System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'))){$r=[System.Security.AccessControl.FileSystemAccessRule]::new($s,[System.Security.AccessControl.FileSystemRights]::FullControl,$flags,[System.Security.AccessControl.PropagationFlags]::None,[System.Security.AccessControl.AccessControlType]::Allow);$acl.AddAccessRule($r)};[System.IO.${directory ? "Directory" : "File"}]::SetAccessControl($p,$acl)`,
      );
    },
    async verifyProtection(path, directory) {
      const stat = await lstat(path);
      if (stat.isDirectory() !== directory || (!directory && (!stat.isFile() || stat.nlink !== 1)))
        throw new Error("unsafe state type");
      await this.verifyEntry(path, stat);
      const result = await inspectDacl(path, directory);
      if (
        result.owner !== result.me ||
        (directory && !result.protected) ||
        !result.rules.some(
          (r) => r.sid === result.me && r.allow && (r.rights & 2032127) === 2032127,
        ) ||
        result.rules.some((r) => !r.allow || ![result.me, "S-1-5-18"].includes(r.sid))
      )
        throw new Error(
          `unsafe executor DACL: ${JSON.stringify({ directory, ownerIsCurrentUser: result.owner === result.me, ownerIsProcessDefault: result.owner === result.tokenOwner, protected: result.protected, ruleCount: result.rules.length, rules: result.rules.slice(0, 8).map((r) => ({ subject: r.sid === result.me ? "current-user" : r.sid === "S-1-5-18" ? "system" : "other", allow: r.allow, rights: r.rights })) })}`,
        );
      // SQLite creates sidecars with the directory's restrictive inheritable DACL.
      // An unprotected file is allowed only under an independently verified protected parent.
      if (!directory && !result.protected) await this.verifyProtection(win32.dirname(path), true);
    },
    async verifyEntry(path, stat) {
      if (
        stat.isSymbolicLink() ||
        (!stat.isDirectory() && !stat.isFile()) ||
        (stat.isFile() && stat.nlink !== 1)
      )
        throw new Error("unsafe workspace link");
      const attributes = await attributeReader.query(path);
      if (!Number.isInteger(attributes) || (attributes & 1024) !== 0)
        throw new Error("reparse point rejected");
    },
    shell(command, cwd, env) {
      return {
        executable: systemFile("WindowsPowerShell\\v1.0\\powershell.exe"),
        args: powershellArgs(command),
        cwd,
        env,
      };
    },
    spawn(spec) {
      return spawn(spec.executable, spec.args, {
        cwd: spec.cwd,
        env: spec.env,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    },
    async cancel(child, graceMs) {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null)
        return { state: "unknown", possibleExternalEffects: true };
      let closed = false;
      child.once("close", () => {
        closed = true;
      });
      const utility = systemFile("taskkill.exe");
      try {
        await exec(utility, ["/PID", String(child.pid), "/T"], {
          timeout: 5000,
          windowsHide: true,
        });
      } catch {
        /* escalation below, live handle only */
      }
      await new Promise<void>((resolve) => setTimeout(resolve, graceMs));
      if (!closed && child.exitCode === null && child.signalCode === null) {
        try {
          await exec(utility, ["/PID", String(child.pid), "/T", "/F"], {
            timeout: 5000,
            windowsHide: true,
          });
        } catch {
          /* disposition remains unknown until close */
        }
      }
      if (!closed)
        await Promise.race([
          new Promise<void>((resolve) => child.once("close", () => resolve())),
          new Promise<void>((resolve) => setTimeout(resolve, 1000)),
        ]);
      return { state: closed ? "stopped" : "unknown", possibleExternalEffects: true };
    },
  };
}
