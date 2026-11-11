import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { FortiPiError } from "fortipi-client/node";

const execute = promisify(execFile);
/** Only platform-essential environment is inherited by helper processes. */
export function helperEnvironment(): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "Path",
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP",
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "XDG_RUNTIME_DIR",
    "LANG",
  ])
    if (process.env[key]) result[key] = process.env[key];
  return result;
}
async function windowsPermissions(path: string, protect = false): Promise<void> {
  // Only this nonsecret path is supplied through an isolated helper environment.
  const script =
    "$p=$env:FORTIPI_ACL_TARGET;$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;" +
    (protect
      ? "$a=Get-Acl -LiteralPath $p;$a.SetAccessRuleProtection($true,$false);foreach($r in @($a.Access)){$a.RemoveAccessRuleSpecific($r)};$id=[System.Security.Principal.SecurityIdentifier]::new($sid);$r=[System.Security.AccessControl.FileSystemAccessRule]::new($id,'FullControl','Allow');$a.AddAccessRule($r);Set-Acl -LiteralPath $p -AclObject $a;"
      : "") +
    "$a=Get-Acl -LiteralPath $p;$rules=@($a.Access|ForEach-Object{@{sid=$_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value;type=[string]$_.AccessControlType;rights=[int]$_.FileSystemRights}});@{owner=$a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;sid=$sid;protected=$a.AreAccessRulesProtected;rules=$rules}|ConvertTo-Json -Compress -Depth 4";
  try {
    const { stdout } = await execute(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      {
        timeout: 3000,
        maxBuffer: 16384,
        windowsHide: true,
        env: { ...helperEnvironment(), FORTIPI_ACL_TARGET: path },
      },
    );
    const acl = JSON.parse(stdout) as {
      sid: string;
      owner: string;
      protected: boolean;
      rules: { sid: string; type: string; rights: number }[];
    };
    if (
      !acl.protected ||
      ![acl.sid, "S-1-5-18", "S-1-5-32-544"].includes(acl.owner) ||
      !acl.rules.length ||
      acl.rules.some(
        (rule) =>
          rule.type === "Allow" && ![acl.sid, "S-1-5-18", "S-1-5-32-544"].includes(rule.sid),
      )
    )
      throw new Error("unsafe");
  } catch {
    throw new FortiPiError("unsafe_credential_permissions");
  }
}
export async function checkProtected(path: string, directory = false): Promise<void> {
  const info = await lstat(path);
  if (
    info.isSymbolicLink() ||
    (directory ? !info.isDirectory() : !info.isFile()) ||
    (!directory && info.nlink !== 1)
  )
    throw new FortiPiError("unsafe_credential_file");
  if (process.platform === "win32") await windowsPermissions(path);
  else if (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
    throw new FortiPiError("unsafe_credential_permissions");
}
export async function protectDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") await windowsPermissions(path, true);
  await checkProtected(path, true);
}
export async function readProtected(path: string): Promise<string> {
  path = resolve(path);
  await checkProtected(dirname(path), true);
  await checkProtected(path);
  const before = await lstat(path);
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await file.stat();
    if (info.ino !== before.ino || info.dev !== before.dev || info.size > 65536 || !info.isFile())
      throw new FortiPiError("unsafe_credential_file");
    const buffer = Buffer.alloc(65537);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 65536) throw new FortiPiError("unsafe_credential_file");
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await file.close();
  }
}
export async function writeProtected(path: string, value: string): Promise<void> {
  await checkProtected(dirname(path), true);
  const file = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    if (process.platform === "win32") await windowsPermissions(path, true);
    await file.writeFile(value);
    await file.sync();
  } finally {
    await file.close();
  }
}
export async function applicationCredential(path: string, endpoint: string): Promise<string> {
  let value: unknown;
  try {
    value = JSON.parse(await readProtected(path));
  } catch {
    throw new FortiPiError("invalid_credential_file");
  }
  const credential = value as {
    version?: unknown;
    endpoint?: unknown;
    role?: unknown;
    token?: unknown;
  };
  if (
    credential.version !== 1 ||
    credential.endpoint !== endpoint ||
    credential.role !== "client" ||
    typeof credential.token !== "string" ||
    !credential.token ||
    credential.token.length > 16384 ||
    /[\r\n]/.test(credential.token)
  )
    throw new FortiPiError("invalid_application_credential");
  return credential.token;
}
