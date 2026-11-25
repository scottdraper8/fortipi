/*
 * Adapted from pnpm 12.23.0, commit 2939f3827a5cfc0de8d1c4b678c7fae58a04cb9e:
 * crates/cmd-shim/src/shim{.rs,/sh.rs,/powershell.rs,/quoting.rs,/relocatable.rs}
 * and crates/package-manifest/src/bins.rs. Only the ordinary Windows,
 * hoisted node_modules / no NODE_PATH contract is supported here.
 *
 * The MIT License (MIT)
 *
 * Copyright (c) 2015-2016 Rico Sta. Cruz and other contributors
 * Copyright (c) 2016-2026 Zoltan Kochan and other contributors
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import assert from "node:assert/strict";
import { win32 } from "node:path";

const shellHeader =
  // biome-ignore lint/suspicious/noTemplateCurlyInString: Pinned shell parameter expansion is literal data.
  '#!/bin/sh\n# Resolve $0 through symlinks so basedir is the shim\'s real directory.\n# Cap hops at the kernel\'s ELOOP limit so a cycle cannot hang the shim.\n#\n# A shim runs with node_modules/.bin at the front of PATH, so readlink, sed,\n# and printf go through `command -p`, which searches the system default path\n# instead. A dependency\'s bin cannot stand in for one of them and take over the\n# shim before it reaches its target. Directories come from `${link%/*}`, which\n# needs no helper at all.\n#\n# Under Cygwin and MSYS every helper a shim runs is another Windows process, so\n# the header runs one only where shell syntax cannot do the job.\n#\n# A helper the default path lacks, as in a Nix build sandbox, comes from PATH\n# instead, with node_modules and relative entries dropped from it.\ncaller_path_set=${PATH+set}\ncaller_path=${PATH-}\nhelper_path=\nrest=$caller_path:\nwhile [ -n "$rest" ]; do\n  dir=${rest%%:*}\n  rest=${rest#*:}\n  case "$dir" in\n    */node_modules/*|*/node_modules) ;;\n    /*) helper_path=${helper_path:+$helper_path:}$dir ;;\n  esac\ndone\n# An empty PATH searches the current directory.\nPATH=${helper_path:-/}\n# A helper comes from PATH only when /usr/bin and /bin lack it and PATH has it.\n# `command -p -v` cannot tell, because the bash 3.2 that macOS ships as sh\n# answers it from PATH. `[ -x ]` also fails where a sandbox denies the file.\nrun_helper() {\n  if [ -x "/usr/bin/$1" ] || [ -x "/bin/$1" ] || ! command -v "$1" >/dev/null 2>&1; then command -p "$@"; else command "$@"; fi\n}\nlink="$0"\n# `${link%/*}` needs a separator to strip. A bare name came from a PATH lookup\n# and stands for a file in the current directory.\ncase "$link" in\n  */*|*\\\\*) ;;\n  *) link="./$link" ;;\nesac\nhops=0\nwhile [ -L "$link" ] && [ "$hops" -lt 40 ]; do\n  hops=$((hops+1))\n  target=$(run_helper readlink "$link")\n  case "$target" in\n    /*) link="$target" ;;\n    *)  link="${link%/*}/$target" ;;\n  esac\ndone\ncase "$link" in\n  *\\\\*) basedir=$(run_helper printf \'%s\\n\' "$link" | run_helper sed -e \'s,\\\\,/,g\') ;;\n  *) basedir=$link ;;\nesac\nbasedir="${basedir%/*}"\n';
const shellPlatform =
  'basedir_win="$basedir"\nexe=""\nmsys=""\n\n# /proc/version starts with the system name `uname -a` reports, and reading it\n# starts no process. Systems without it, such as macOS, take no branch.\nos=\n{ read -r os < /proc/version; } 2> /dev/null || :\ncase "$os" in\n  *CYGWIN*|*MINGW*|*MSYS*)\n    if converted=$(command -p cygpath -w "$basedir" 2>/dev/null) && [ -n "$converted" ]; then\n      basedir_win="$converted"\n    elif command -v cygpath > /dev/null 2>&1; then\n      basedir_win=`cygpath -w "$basedir"`\n    fi\n    exe=".exe"\n    msys="true"\n  ;;\n  *WSL2*)\n    if converted=$(command -p wslpath -w "$basedir" 2>/dev/null) && [ -n "$converted" ]; then\n      basedir_win="$converted"\n      exe=".exe"\n    elif command -v wslpath > /dev/null 2>&1; then\n      basedir_win="$(wslpath -w "$basedir" 2> /dev/null)"\n      if [ $? -ne 0 ] || [ -z "$basedir_win" ]; then\n        basedir_win="$basedir"\n      else\n        exe=".exe"\n      fi\n    fi\n  ;;\nesac\nif [ -n "$caller_path_set" ]; then PATH=$caller_path; else unset PATH; fi\n\n';
const basedirPrelude =
  'basedir_abs=$(CDPATH= cd -P -- "$basedir" && pwd -P) || exit $?\nbasedir="$basedir_abs"\n';
const powershellHeader =
  '#!/usr/bin/env pwsh\n$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent\n\n$exe=""\nif ($PSVersionTable.PSVersion -lt "6.0" -or $IsWindows) {\n  # Fix case when both the Windows and Linux builds of Node\n  # are installed in the same directory\n  $exe=".exe"\n}';

export interface WindowsBinEntrypoint {
  suffix: "" | ".cmd" | ".ps1";
  bytes: Buffer;
}

// Rust char::is_whitespace excludes BOM and includes NEL, unlike JS \s.
function whitespace(value: string | undefined): boolean {
  const code = value?.charCodeAt(0) ?? -1;
  return (
    (code >= 9 && code <= 13) ||
    (code >= 0x2000 && code <= 0x200a) ||
    [0x20, 0x85, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000].includes(code)
  );
}
function trimStart(value: string): string {
  let at = 0;
  while (whitespace(value[at])) at++;
  return value.slice(at);
}
const nonAscii = (value: string) => [...value].some((char) => char.charCodeAt(0) > 127);
const control = (value: string, allowTab = false) =>
  [...value].some((char) => {
    const code = char.charCodeAt(0);
    return (code < 32 && !(allowTab && code === 9)) || code === 127;
  });

/** pnpm's byte-zero, 512-byte shebang parser, including argument whitespace. */
function runtime(target: string, bytes: Uint8Array): { prog: string; args: string } | null {
  const head = Buffer.from(bytes.subarray(0, 512));
  if (head[0] === 35 && head[1] === 33) {
    const end = head.indexOf(10);
    let rest = trimStart(
      head
        .subarray(0, end < 0 ? head.length : end)
        .toString("utf8")
        .replace(/\r+$/, "")
        .slice(2),
    );
    if (rest.startsWith("/usr/bin/env")) {
      const after = rest.slice(12);
      if (!after || /^[ \t]/.test(after)) {
        rest = trimStart(after);
        if (rest.startsWith("-S") && (rest.length === 2 || /^[ \t]/.test(rest.slice(2))))
          rest = rest.slice(2);
      }
    }
    rest = trimStart(rest);
    const at = rest.search(/[ \t]/);
    const prog = at < 0 ? rest : rest.slice(0, at);
    if (prog) {
      // Embedded quotes/control characters cannot be represented as a Windows
      // interpreter name. Reject unsupported syntax instead of interpreting it.
      assert.match(prog, /^[A-Za-z0-9_./\\:-]+$/, "Unsupported Windows bin interpreter");
      const args = at < 0 ? "" : rest.slice(at);
      assert.ok(!control(args, true), "Unsupported Windows bin arguments");
      return { prog, args };
    }
  }
  const extension = win32.extname(target).slice(1).toLowerCase();
  const prog = (
    {
      js: "node",
      cjs: "node",
      mjs: "node",
      cmd: "cmd",
      bat: "cmd",
      ps1: "pwsh",
      sh: "sh",
    } as Record<string, string>
  )[extension];
  return prog ? { prog, args: prog === "cmd" ? "/C" : "" } : null;
}

function relativeTarget(target: string, shim: string): string {
  assert.ok(
    win32.isAbsolute(target) && win32.isAbsolute(shim),
    "Windows bin needs absolute planned paths",
  );
  assert.equal(win32.normalize(target), target, "Noncanonical Windows bin target");
  assert.equal(win32.normalize(shim), shim, "Noncanonical Windows bin path");
  assert.equal(
    win32.parse(target).root,
    win32.parse(shim).root,
    "Windows bin target changed volume",
  );
  assert.ok(
    !control(target + shim) && !/["$`]/.test(target + shim),
    "Unsupported Windows bin path",
  );
  const from = win32.dirname(shim).split("\\"),
    to = target.split("\\");
  let common = 0;
  while (common < from.length && common < to.length && from[common] === to[common]) common++;
  const relative = [...from.slice(common).map(() => ".."), ...to.slice(common)].join("/") || ".";
  assert.equal(win32.resolve(win32.dirname(shim), relative), target, "Windows bin target changed");
  return relative;
}

const singleQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const cmdEscape = (value: string) => value.replaceAll("%", "%%");

function shellBody(target: string, relative: string, rt: ReturnType<typeof runtime>): string {
  const quoted = `"$basedir_abs"/${singleQuote(relative)}`;
  const windowsQuoted = `"$basedir_win"/${singleQuote(relative)}`;
  let body = shellHeader + basedirPrelude + shellPlatform;
  if (rt) {
    const prog = rt.prog,
      hasExe = /\.exe$/i.test(prog);
    const progBase = hasExe ? prog.slice(0, -4) : prog;
    const progExe = hasExe ? prog : `${prog}.exe`;
    let args = rt.args;
    if (progBase.toLowerCase() === "cmd") {
      for (let at = 0; at < args.length; at++) {
        if (at > 0 && !whitespace(args[at - 1])) continue;
        const token = args.slice(at, at + 2).toUpperCase();
        if (
          (token !== "/C" && token !== "/K") ||
          (at + 2 < args.length && !whitespace(args[at + 2]))
        )
          continue;
        args = args.slice(0, at) + token + args.slice(at + 2);
        body += `if [ -n "$msys" ]; then\n  export MSYS2_ARG_CONV_EXCL="${token}\${MSYS2_ARG_CONV_EXCL:+;$MSYS2_ARG_CONV_EXCL}"\nfi\n`;
        break;
      }
    }
    const localExe = `"$basedir/${progExe}"`,
      localProg = `"$basedir/${prog}"`;
    if (hasExe) {
      body += `if [ -x ${localExe} ]; then\n  exec ${localExe} ${args} ${windowsQuoted} "$@"\nelse\n  exec ${progExe} ${args} ${windowsQuoted} "$@"\nfi\n`;
    } else {
      body += `if [ -n "$exe" ] && [ -x ${localExe} ]; then\n  exec ${localExe} ${args} ${windowsQuoted} "$@"\nelif [ -x ${localProg} ]; then\n  exec ${localProg} ${args} ${quoted} "$@"\nelif [ -n "$msys" ] && command -v ${prog} >/dev/null 2>&1; then\n  exec ${prog} ${args} ${windowsQuoted} "$@"\nelif command -v ${prog} >/dev/null 2>&1; then\n  exec ${prog} ${args} ${quoted} "$@"\nelif [ -n "$exe" ] && command -v ${progExe} >/dev/null 2>&1; then\n  exec ${progExe} ${args} ${windowsQuoted} "$@"\nelse\n  exec ${prog} ${args} ${quoted} "$@"\nfi\n`;
    }
  } else {
    body += `exec ${quoted}  "$@"\nexit $?\n`;
  }
  return `${body}# cmd-shim-target=${target}\n`;
}

function cmdBody(relative: string, rt: ReturnType<typeof runtime>): string {
  const target = `"%~dp0\\${cmdEscape(relative.replaceAll("/", "\\"))}"`;
  let body = "@SETLOCAL\r\n";
  if (rt) {
    const prog = cmdEscape(rt.prog),
      args = cmdEscape(rt.args),
      local = `"%~dp0\\${prog}.exe"`;
    body += `@IF EXIST ${local} (\r\n  ${local} ${args} ${target} %*\r\n) ELSE (\r\n  @SET PATHEXT=%PATHEXT:;.JS;=;%\r\n  ${prog} ${args} ${target} %*\r\n)\r\n`;
  } else body += `@${target}  %*\r\n`;
  if (nonAscii(body)) {
    body = body.replace(
      "@SETLOCAL\r\n",
      '@SETLOCAL\r\n@SET "_PNPM_CODEPAGE="\r\n@FOR /F "tokens=2 delims=:" %%a IN (\'"%SystemRoot%\\System32\\mode.com" con cp\') DO @SET "_PNPM_CODEPAGE=%%a"\r\n@"%SystemRoot%\\System32\\mode.com" con cp select=65001 >NUL\r\n@SET "ERRORLEVEL="\r\n',
    );
    body +=
      '@SET "_PNPM_EXIT_CODE=%ERRORLEVEL%"\r\n@IF DEFINED _PNPM_CODEPAGE @"%SystemRoot%\\System32\\mode.com" con cp select=%_PNPM_CODEPAGE: =% >NUL\r\n@EXIT /B %_PNPM_EXIT_CODE%\r\n';
  }
  return body;
}

function powershellBody(relative: string, rt: ReturnType<typeof runtime>): string {
  const target = `"$basedir/${relative}"`;
  const invoke = (command: string, indent: string) =>
    `${indent}# Support pipeline input\n${indent}if ($MyInvocation.ExpectingInput) {\n${indent}  $input | & ${command}\n${indent}} else {\n${indent}  & ${command}\n${indent}}\n`;
  let body = `${powershellHeader}\n`;
  if (rt) {
    const local = `"$basedir/${rt.prog}$exe"`,
      prog = `"${rt.prog}$exe"`;
    body += `$ret=0\nif (Test-Path ${local}) {\n`;
    body += `${invoke(`${local} ${rt.args} ${target} $args`, "  ")}  $ret=$LASTEXITCODE\n} else {\n`;
    body += `${invoke(`${prog} ${rt.args} ${target} $args`, "  ")}  $ret=$LASTEXITCODE\n}\nexit $ret\n`;
  } else body += `${invoke(`${target}  $args`, "")}exit $LASTEXITCODE\n`;
  return nonAscii(body) ? `\uFEFF${body}` : body;
}

/** No filesystem reads, shell execution or installed-byte baseline. */
export function windowsBinEntrypoints(
  target: string,
  shim: string,
  authenticatedTarget: Uint8Array,
  packageName: string,
): WindowsBinEntrypoint[] {
  assert.ok(
    packageName !== "pnpm" && packageName !== "@pnpm/exe",
    "Unsupported self-updating Windows bin",
  );
  assert.ok(!/^node(?:\.exe)?$/i.test(win32.basename(shim)), "Unsupported native Windows node bin");
  const relative = relativeTarget(target, shim),
    rt = runtime(target, authenticatedTarget);
  return [
    { suffix: "", bytes: Buffer.from(shellBody(target, relative, rt)) },
    { suffix: ".cmd", bytes: Buffer.from(cmdBody(relative, rt)) },
    { suffix: ".ps1", bytes: Buffer.from(powershellBody(relative, rt)) },
  ];
}
