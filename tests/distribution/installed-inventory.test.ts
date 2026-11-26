import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { safePath } from "../../scripts/verify-release-gates.ts";
import { installedPackageInventory } from "./installed-inventory.ts";
import { windowsBinEntrypoints } from "./windows-bin-entrypoints.ts";

test("installed inventory accepts authenticated bundled dependencies while rejecting hidden or changed physical members", async () => {
  const root = await mkdtemp(resolve(await realpath(tmpdir()), "fortipi-installed-inventory-"));
  const hardlink = `${root}.linked-member`;
  const nested = resolve(root, "node_modules/ajv");
  await mkdir(nested, { recursive: true });
  const files = [
    { path: "package.json", bytes: Buffer.from('{"name":"synthetic-owned"}\n'), mode: 0o644 },
    { path: "node_modules/ajv/package.json", bytes: Buffer.from('{"name":"ajv"}\n'), mode: 0o644 },
    { path: "bin.js", bytes: Buffer.from("#!/usr/bin/env node\n"), mode: 0o755 },
  ] as const;
  const expected = files.map((file) => ({
    path: file.path,
    mode: file.mode,
    size: file.bytes.length,
    sha256: createHash("sha256").update(file.bytes).digest("hex"),
  }));
  for (const file of files) {
    await writeFile(resolve(root, file.path), file.bytes);
    await chmod(resolve(root, file.path), file.mode & 0o111 ? 0o555 : 0o444);
  }
  const directories = [root, resolve(root, "node_modules"), nested];
  for (const directory of directories) await chmod(directory, 0o555);
  try {
    assert.throws(
      () => safePath("node_modules/ajv/package.json"),
      "Generic artifact policy remains strict",
    );
    const original = await installedPackageInventory(root, expected);
    assert.deepEqual(
      original.files.map((file) => ({ path: file.path, size: file.size, sha256: file.sha256 })),
      [...expected]
        .sort((a, b) => a.path.localeCompare(b.path, "en"))
        .map(({ path, size, sha256 }) => ({ path, size, sha256 })),
    );
    if (process.platform !== "win32") {
      const executable = resolve(root, "bin.js");
      await chmod(executable, 0o444);
      await assert.rejects(
        installedPackageInventory(root, expected),
        /Installed executable mode differs from archive intent/,
      );
      await chmod(executable, 0o555);
    }
    const unknown = resolve(root, "hidden.js");
    await chmod(root, 0o700);
    await writeFile(unknown, "hidden", { mode: 0o444 });
    await chmod(root, 0o555);
    await assert.rejects(
      installedPackageInventory(root, expected),
      /Unexpected installed package member/,
    );
    await chmod(root, 0o700);
    await rm(unknown);
    await mkdir(resolve(root, "empty"), { mode: 0o555 });
    await chmod(root, 0o555);
    await assert.rejects(
      installedPackageInventory(root, expected),
      /Unexpected installed package member/,
    );
    await chmod(root, 0o700);
    await rm(resolve(root, "empty"), { recursive: true });
    await chmod(root, 0o555);
    const target = resolve(nested, "package.json");
    await chmod(target, 0o644);
    await assert.rejects(installedPackageInventory(root, expected), /read-only/);
    await writeFile(target, Buffer.from('{"name":"bad"}\n'));
    await chmod(target, 0o444);
    await assert.rejects(installedPackageInventory(root, expected), /bytes changed/);
    await chmod(target, 0o644);
    await writeFile(target, files[1].bytes);
    await chmod(target, 0o444);
    await link(target, hardlink);
    await assert.rejects(installedPackageInventory(root, expected));
    await rm(hardlink);
    await chmod(nested, 0o700);
    await rm(target);
    await symlink(resolve(root, "package.json"), target);
    await chmod(nested, 0o555);
    await assert.rejects(installedPackageInventory(root, expected), /Linked installed/);
    await chmod(nested, 0o700);
    await rm(target);
    await writeFile(target, files[1].bytes, { mode: 0o444 });
    await chmod(nested, 0o555);
    assert.deepEqual(await installedPackageInventory(root, expected), original);
  } finally {
    await rm(hardlink, { force: true });
    for (const directory of directories) await chmod(directory, 0o700);
    await rm(root, { recursive: true, force: true });
  }
});

test("only package-declared bin links to authenticated executable bytes join the installed inventory", async () => {
  // Literal full bodies from the pinned pnpm Rust templates, not our renderer.
  const windowsNode = [
    {
      suffix: "",
      bytes: Buffer.from(
        // biome-ignore lint/suspicious/noTemplateCurlyInString: Pinned shell parameter expansion is literal data.
        '#!/bin/sh\n# Resolve $0 through symlinks so basedir is the shim\'s real directory.\n# Cap hops at the kernel\'s ELOOP limit so a cycle cannot hang the shim.\n#\n# A shim runs with node_modules/.bin at the front of PATH, so readlink, sed,\n# and printf go through `command -p`, which searches the system default path\n# instead. A dependency\'s bin cannot stand in for one of them and take over the\n# shim before it reaches its target. Directories come from `${link%/*}`, which\n# needs no helper at all.\n#\n# Under Cygwin and MSYS every helper a shim runs is another Windows process, so\n# the header runs one only where shell syntax cannot do the job.\n#\n# A helper the default path lacks, as in a Nix build sandbox, comes from PATH\n# instead, with node_modules and relative entries dropped from it.\ncaller_path_set=${PATH+set}\ncaller_path=${PATH-}\nhelper_path=\nrest=$caller_path:\nwhile [ -n "$rest" ]; do\n  dir=${rest%%:*}\n  rest=${rest#*:}\n  case "$dir" in\n    */node_modules/*|*/node_modules) ;;\n    /*) helper_path=${helper_path:+$helper_path:}$dir ;;\n  esac\ndone\n# An empty PATH searches the current directory.\nPATH=${helper_path:-/}\n# A helper comes from PATH only when /usr/bin and /bin lack it and PATH has it.\n# `command -p -v` cannot tell, because the bash 3.2 that macOS ships as sh\n# answers it from PATH. `[ -x ]` also fails where a sandbox denies the file.\nrun_helper() {\n  if [ -x "/usr/bin/$1" ] || [ -x "/bin/$1" ] || ! command -v "$1" >/dev/null 2>&1; then command -p "$@"; else command "$@"; fi\n}\nlink="$0"\n# `${link%/*}` needs a separator to strip. A bare name came from a PATH lookup\n# and stands for a file in the current directory.\ncase "$link" in\n  */*|*\\\\*) ;;\n  *) link="./$link" ;;\nesac\nhops=0\nwhile [ -L "$link" ] && [ "$hops" -lt 40 ]; do\n  hops=$((hops+1))\n  target=$(run_helper readlink "$link")\n  case "$target" in\n    /*) link="$target" ;;\n    *)  link="${link%/*}/$target" ;;\n  esac\ndone\ncase "$link" in\n  *\\\\*) basedir=$(run_helper printf \'%s\\n\' "$link" | run_helper sed -e \'s,\\\\,/,g\') ;;\n  *) basedir=$link ;;\nesac\nbasedir="${basedir%/*}"\nbasedir_abs=$(CDPATH= cd -P -- "$basedir" && pwd -P) || exit $?\nbasedir="$basedir_abs"\nbasedir_win="$basedir"\nexe=""\nmsys=""\n\n# /proc/version starts with the system name `uname -a` reports, and reading it\n# starts no process. Systems without it, such as macOS, take no branch.\nos=\n{ read -r os < /proc/version; } 2> /dev/null || :\ncase "$os" in\n  *CYGWIN*|*MINGW*|*MSYS*)\n    if converted=$(command -p cygpath -w "$basedir" 2>/dev/null) && [ -n "$converted" ]; then\n      basedir_win="$converted"\n    elif command -v cygpath > /dev/null 2>&1; then\n      basedir_win=`cygpath -w "$basedir"`\n    fi\n    exe=".exe"\n    msys="true"\n  ;;\n  *WSL2*)\n    if converted=$(command -p wslpath -w "$basedir" 2>/dev/null) && [ -n "$converted" ]; then\n      basedir_win="$converted"\n      exe=".exe"\n    elif command -v wslpath > /dev/null 2>&1; then\n      basedir_win="$(wslpath -w "$basedir" 2> /dev/null)"\n      if [ $? -ne 0 ] || [ -z "$basedir_win" ]; then\n        basedir_win="$basedir"\n      else\n        exe=".exe"\n      fi\n    fi\n  ;;\nesac\nif [ -n "$caller_path_set" ]; then PATH=$caller_path; else unset PATH; fi\n\nif [ -n "$exe" ] && [ -x "$basedir/node.exe" ]; then\n  exec "$basedir/node.exe"  "$basedir_win"/\'../declared/bin/run.js\' "$@"\nelif [ -x "$basedir/node" ]; then\n  exec "$basedir/node"  "$basedir_abs"/\'../declared/bin/run.js\' "$@"\nelif [ -n "$msys" ] && command -v node >/dev/null 2>&1; then\n  exec node  "$basedir_win"/\'../declared/bin/run.js\' "$@"\nelif command -v node >/dev/null 2>&1; then\n  exec node  "$basedir_abs"/\'../declared/bin/run.js\' "$@"\nelif [ -n "$exe" ] && command -v node.exe >/dev/null 2>&1; then\n  exec node.exe  "$basedir_win"/\'../declared/bin/run.js\' "$@"\nelse\n  exec node  "$basedir_abs"/\'../declared/bin/run.js\' "$@"\nfi\n# cmd-shim-target=C:/owned/node_modules/declared/bin/run.js\n',
      ),
    },
    {
      suffix: ".cmd",
      bytes: Buffer.from(
        '@SETLOCAL\r\n@IF EXIST "%~dp0\\node.exe" (\r\n  "%~dp0\\node.exe"  "%~dp0\\..\\declared\\bin\\run.js" %*\r\n) ELSE (\r\n  @SET PATHEXT=%PATHEXT:;.JS;=;%\r\n  node  "%~dp0\\..\\declared\\bin\\run.js" %*\r\n)\r\n',
      ),
    },
    {
      suffix: ".ps1",
      bytes: Buffer.from(
        '#!/usr/bin/env pwsh\n$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent\n\n$exe=""\nif ($PSVersionTable.PSVersion -lt "6.0" -or $IsWindows) {\n  # Fix case when both the Windows and Linux builds of Node\n  # are installed in the same directory\n  $exe=".exe"\n}\n$ret=0\nif (Test-Path "$basedir/node$exe") {\n  # Support pipeline input\n  if ($MyInvocation.ExpectingInput) {\n    $input | & "$basedir/node$exe"  "$basedir/../declared/bin/run.js" $args\n  } else {\n    & "$basedir/node$exe"  "$basedir/../declared/bin/run.js" $args\n  }\n  $ret=$LASTEXITCODE\n} else {\n  # Support pipeline input\n  if ($MyInvocation.ExpectingInput) {\n    $input | & "node$exe"  "$basedir/../declared/bin/run.js" $args\n  } else {\n    & "node$exe"  "$basedir/../declared/bin/run.js" $args\n  }\n  $ret=$LASTEXITCODE\n}\nexit $ret\n',
      ),
    },
  ];
  assert.deepEqual(
    windowsBinEntrypoints(
      "C:\\owned\\node_modules\\declared\\bin\\run.js",
      "C:\\owned\\node_modules\\.bin\\run-tool",
      Buffer.from("#!/usr/bin/env node\n"),
      "declared",
    ),
    windowsNode,
  );
  // The upstream parser preserves the whitespace before interpreter arguments.
  assert.deepEqual(
    windowsBinEntrypoints(
      "C:\\owned\\node_modules\\declared\\bin\\run.js",
      "C:\\owned\\node_modules\\.bin\\run-tool",
      Buffer.from("#!/usr/bin/env -S node --no-warnings\r\n"),
      "declared",
    )[1]?.bytes,
    Buffer.from(
      '@SETLOCAL\r\n@IF EXIST "%~dp0\\node.exe" (\r\n  "%~dp0\\node.exe"  --no-warnings "%~dp0\\..\\declared\\bin\\run.js" %*\r\n) ELSE (\r\n  @SET PATHEXT=%PATHEXT:;.JS;=;%\r\n  node  --no-warnings "%~dp0\\..\\declared\\bin\\run.js" %*\r\n)\r\n',
    ),
  );
  // A shebang after byte zero (or outside the 512-byte head) supplies no runtime.
  for (const head of [
    Buffer.from("\uFEFF#!/usr/bin/env node\n"),
    Buffer.from(" #!/usr/bin/env node\n"),
    Buffer.concat([Buffer.alloc(512, 32), Buffer.from("#!/usr/bin/env node\n")]),
  ]) {
    assert.deepEqual(
      windowsBinEntrypoints(
        "C:\\owned\\node_modules\\declared\\bin\\run.bin",
        "C:\\owned\\node_modules\\.bin\\run-tool",
        head,
        "declared",
      )[1]?.bytes,
      Buffer.from('@SETLOCAL\r\n@"%~dp0\\..\\declared\\bin\\run.bin"  %*\r\n'),
    );
  }
  const root = await mkdtemp(resolve(await realpath(tmpdir()), "fortipi-installed-bins-"));
  const module = resolve(root, "node_modules/declared"),
    bins = resolve(root, "node_modules/.bin");
  await mkdir(resolve(module, "bin"), { recursive: true });
  await mkdir(bins);
  const members = [
    {
      path: "node_modules/declared/package.json",
      bytes: Buffer.from('{"name":"declared","bin":{"run-tool":"./bin/run.js"}}\n'),
      mode: 0o644,
    },
    {
      path: "node_modules/declared/bin/run.js",
      bytes: Buffer.from("#!/usr/bin/env node\n"),
      mode: 0o755,
    },
  ];
  const expected = members.map((file) => ({
    path: file.path,
    mode: file.mode,
    size: file.bytes.length,
    sha256: createHash("sha256").update(file.bytes).digest("hex"),
  }));
  for (const file of members) {
    await writeFile(resolve(root, file.path), file.bytes);
    await chmod(resolve(root, file.path), file.mode & 0o111 ? 0o555 : 0o444);
  }
  const command = resolve(bins, "run-tool"),
    binHardlink = `${root}.bin-linked`;
  await symlink("../declared/bin/run.js", command);
  const directories = [root, resolve(root, "node_modules"), module, resolve(module, "bin"), bins];
  for (const path of directories) await chmod(path, 0o555);
  try {
    const original = await installedPackageInventory(root, expected);
    assert.equal(original.files.length, 2);
    assert.deepEqual(original.binLinks, [
      {
        path: "node_modules/.bin/run-tool",
        target: "node_modules/declared/bin/run.js",
        relativeTarget: "../declared/bin/run.js",
        manifest: "node_modules/declared/package.json",
        manifestSha256: expected[0]?.sha256,
        targetSha256: expected[1]?.sha256,
      },
    ]);
    await chmod(bins, 0o755);
    await assert.rejects(installedPackageInventory(root, expected), /read-only/);
    await chmod(bins, 0o555);
    await chmod(bins, 0o700);
    await rm(command);
    await symlink("../declared/package.json", command);
    await chmod(bins, 0o555);
    await assert.rejects(installedPackageInventory(root, expected), /bin target changed/);
    await chmod(bins, 0o700);
    await rm(command);
    await writeFile(command, "replacement shim", { mode: 0o555 });
    await chmod(bins, 0o555);
    await assert.rejects(installedPackageInventory(root, expected), /exact declared link/);
    await chmod(bins, 0o700);
    await rm(command);
    await symlink("../declared/bin/run.js", command);
    await symlink("../declared/bin/run.js", resolve(bins, "undeclared-alias"));
    await chmod(bins, 0o555);
    await assert.rejects(installedPackageInventory(root, expected), /Unexpected installed package/);
    await chmod(bins, 0o700);
    await rm(resolve(bins, "undeclared-alias"));
    await rm(command);
    await chmod(bins, 0o555);
    await assert.rejects(installedPackageInventory(root, expected), /Missing installed bin link/);
    await chmod(bins, 0o700);
    await symlink("../declared/bin/run.js", command);
    await chmod(bins, 0o555);
    if (process.platform === "win32") {
      const physical = windowsNode.map(({ suffix, bytes }) => ({
        suffix,
        path: command + suffix,
        bytes:
          suffix === ""
            ? Buffer.from(
                bytes
                  .toString()
                  .replace(
                    "C:/owned/node_modules/declared/bin/run.js",
                    resolve(module, "bin/run.js").replaceAll("\\", "/"),
                  ),
              )
            : bytes,
      }));
      await chmod(bins, 0o700);
      await rm(command);
      for (const member of physical) {
        await writeFile(member.path, member.bytes);
        await chmod(member.path, 0o555);
      }
      await chmod(bins, 0o555);
      const shimInventory = await installedPackageInventory(root, expected);
      assert.deepEqual(shimInventory.binLinks, original.binLinks);
      assert.equal(shimInventory.files.length, 2);
      assert.equal(shimInventory.binEntries.length, 3);
      const [shell, batch, powershell] = physical;
      assert.ok(shell && batch && powershell);
      const mutations = [
        [shell, shell.bytes.toString().replace("exec node  ", "exec sh  ")],
        [
          shell,
          shell.bytes.toString().replace("# cmd-shim-target=", "# cmd-shim-target=elsewhere/"),
        ],
        [batch, batch.bytes.toString().replace("node.exe", "sh.exe")],
        [
          batch,
          batch.bytes
            .toString()
            .replace("@SETLOCAL\r\n", "@SETLOCAL\r\n@SET NODE_PATH=elsewhere\r\n"),
        ],
        [powershell, `${powershell.bytes.toString()}Write-Output unexpected\n`],
      ] as const;
      for (const [member, changed] of mutations) {
        assert.notEqual(changed, member.bytes.toString());
        await chmod(member.path, 0o644);
        await writeFile(member.path, changed);
        await chmod(member.path, 0o555);
        await assert.rejects(installedPackageInventory(root, expected), /exact declared link/);
        await chmod(member.path, 0o644);
        await writeFile(member.path, member.bytes);
        await chmod(member.path, 0o555);
      }
      await chmod(batch.path, 0o644);
      await assert.rejects(installedPackageInventory(root, expected), /read-only/);
      await chmod(batch.path, 0o555);
      await link(batch.path, binHardlink);
      await assert.rejects(
        installedPackageInventory(root, expected),
        /Unexpected installed package member/,
      );
      await rm(binHardlink);
      await chmod(bins, 0o700);
      await rm(powershell.path);
      await chmod(bins, 0o555);
      await assert.rejects(installedPackageInventory(root, expected), /Missing installed bin link/);
      await chmod(bins, 0o700);
      await writeFile(powershell.path, powershell.bytes);
      await chmod(powershell.path, 0o555);
      const extraAlias = resolve(bins, "run-tool.extra");
      await writeFile(extraAlias, batch.bytes);
      await chmod(extraAlias, 0o555);
      await chmod(bins, 0o555);
      await assert.rejects(
        installedPackageInventory(root, expected),
        /Unexpected installed package member/,
      );
      await chmod(bins, 0o700);
      await rm(extraAlias);
      await chmod(bins, 0o555);
      // A signed archive hash does not independently establish declared bin intent.
      const archived = [
        ...expected,
        ...physical.map((member) => ({
          path: `node_modules/.bin/run-tool${member.suffix}`,
          mode: 0o755,
          size: member.bytes.length,
          sha256: createHash("sha256").update(member.bytes).digest("hex"),
        })),
      ];
      assert.equal((await installedPackageInventory(root, archived)).files.length, 5);
      const changed = batch.bytes.toString().replace("node.exe", "sh.exe");
      await chmod(batch.path, 0o644);
      await writeFile(batch.path, changed);
      await chmod(batch.path, 0o555);
      const archiveWithDifferentIntent = archived.map((member) =>
        member.path.endsWith("run-tool.cmd")
          ? {
              ...member,
              size: Buffer.byteLength(changed),
              sha256: createHash("sha256").update(changed).digest("hex"),
            }
          : member,
      );
      await assert.rejects(
        installedPackageInventory(root, archiveWithDifferentIntent),
        /exact declared link/,
      );
      await chmod(bins, 0o700);
      for (const member of physical) {
        await chmod(member.path, 0o644);
        await rm(member.path);
      }
      await symlink("../declared/bin/run.js", command);
      await chmod(bins, 0o555);
    }
    assert.deepEqual(await installedPackageInventory(root, expected), original);
  } finally {
    await rm(binHardlink, { force: true });
    for (const directory of directories) await chmod(directory, 0o700);
    await rm(root, { recursive: true, force: true });
  }
});
