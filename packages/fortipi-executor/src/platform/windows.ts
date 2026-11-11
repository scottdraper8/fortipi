import { execFile, spawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import { isAbsolute, win32 } from "node:path";
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
function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
async function ps(command: string): Promise<string> {
  const { stdout } = await exec(
    systemFile("WindowsPowerShell\\v1.0\\powershell.exe"),
    powershellArgs(`$ErrorActionPreference='Stop';${command}`),
    {
      windowsHide: true,
      timeout: 10000,
      maxBuffer: 65536,
      env: { SystemRoot: process.env.SystemRoot ?? "" },
    },
  );
  return stdout.trim();
}
export function windows(): PlatformAdapter {
  return {
    platform: "win32",
    confinement: "host",
    async protect(path, directory) {
      const type = directory ? "DirectorySecurity" : "FileSecurity";
      await ps(
        `$p=${literal(path)};$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User;$acl=New-Object System.Security.AccessControl.${type};$acl.SetOwner($sid);$acl.SetAccessRuleProtection($true,$false);$flags=${directory ? "'ContainerInherit,ObjectInherit'" : "'None'"};foreach($s in @($sid,[System.Security.Principal.SecurityIdentifier]'S-1-5-18')){$r=New-Object System.Security.AccessControl.FileSystemAccessRule($s,'FullControl',$flags,'None','Allow');$acl.AddAccessRule($r)};Set-Acl -LiteralPath $p -AclObject $acl`,
      );
    },
    async verifyProtection(path, directory) {
      const stat = await lstat(path);
      if (stat.isDirectory() !== directory || (!directory && (!stat.isFile() || stat.nlink !== 1)))
        throw new Error("unsafe state type");
      await this.verifyEntry(path, stat);
      const result = JSON.parse(
        await ps(
          `$a=Get-Acl -LiteralPath ${literal(path)};$me=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;[pscustomobject]@{owner=$a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;me=$me;protected=$a.AreAccessRulesProtected;rules=@($a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])|ForEach-Object{[pscustomobject]@{sid=$_.IdentityReference.Value;allow=($_.AccessControlType -eq 'Allow');rights=[int64]$_.FileSystemRights}})}|ConvertTo-Json -Depth 4`,
        ),
      ) as {
        owner: string;
        me: string;
        protected: boolean;
        rules: { sid: string; allow: boolean; rights: number }[];
      };
      if (
        result.owner !== result.me ||
        !result.protected ||
        !result.rules.some(
          (r) => r.sid === result.me && r.allow && (r.rights & 2032127) === 2032127,
        ) ||
        result.rules.some((r) => !r.allow || ![result.me, "S-1-5-18"].includes(r.sid))
      )
        throw new Error("unsafe executor DACL");
    },
    async verifyEntry(path, stat) {
      if (
        stat.isSymbolicLink() ||
        (!stat.isDirectory() && !stat.isFile()) ||
        (stat.isFile() && stat.nlink !== 1)
      )
        throw new Error("unsafe workspace link");
      const attributes = Number(
        await ps(`[int](Get-Item -Force -LiteralPath ${literal(path)}).Attributes`),
      );
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
