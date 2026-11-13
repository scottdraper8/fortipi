import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import type { ApplicationRecoveryBridge } from "../../../tests/clients/platform-recovery.ts";
import { attachApplicationRecoveryChannel } from "../../application-recovery-channel.ts";
import { repository } from "../../build-workspaces.ts";
import { childEnvironment, execute } from "../../prepare-release.ts";
import { sha256 } from "../../verify-release-gates.ts";

const directory = resolve(repository, ".agent-docs/tmp/recovery-channel-fixture");
const before = {
  path: resolve(directory, "application-before.json"),
  size: 2,
  mode: 0o600,
  sha256: sha256("{}"),
};
const after = { ...before, path: resolve(directory, "application-after.json") };
const moduleUrl = pathToFileURL(
  resolve(repository, "scripts/application-recovery-channel.ts"),
).href;
async function run(
  source: string,
  coordinator: Parameters<typeof attachApplicationRecoveryChannel>[2],
  forbidden: string[] = [],
) {
  let channel: ReturnType<typeof attachApplicationRecoveryChannel> | undefined;
  const errors: Buffer[] = [];
  const result = await execute(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import {applicationRecoveryChannel} from ${JSON.stringify(moduleUrl)};
    try { ${source} } finally { process.disconnect?.(); }
  `,
    ],
    repository,
    childEnvironment(),
    10000,
    false,
    (child) => {
      channel = attachApplicationRecoveryChannel(child, directory, coordinator, forbidden);
      assert.ok(child.stderr);
      child.stderr.on("data", (bytes) => errors.push(Buffer.from(bytes)));
    },
  );
  assert.ok(channel);
  try {
    let rejection = "";
    try {
      await channel.settled();
    } catch (error) {
      rejection = String(error);
    }
    return {
      code: result.code,
      stdout: result.stdout,
      stderr: Buffer.concat(errors).toString(),
      rejection,
    };
  } finally {
    channel.close();
  }
}

test("inherited IPC carries only the bound before/after records, in order, without granting recovery qualification", async () => {
  const calls: string[] = [];
  const bridge: ApplicationRecoveryBridge = {
    async perform(file) {
      assert.deepEqual(file, before);
      calls.push("before");
      return { status: "unavailable", reason: "Transport fixture; no provider operation" };
    },
    async finish(file) {
      assert.deepEqual(file, after);
      calls.push("after");
      return { status: "unavailable", reason: "Transport fixture; no application proof" };
    },
  };
  const result = await run(
    `
    const bridge=applicationRecoveryChannel('perform');
    const first=await bridge.perform(${JSON.stringify(before)});
    const second=await bridge.finish(${JSON.stringify(after)});
    console.log(JSON.stringify({statuses:[first.status,second.status],github:!!process.env.GITHUB_TOKEN,cloudflare:!!process.env.CLOUDFLARE_API_TOKEN,npm:!!process.env.NPM_TOKEN}));
  `,
    { mode: "perform", bridge },
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.rejection, "");
  assert.deepEqual(calls, ["before", "after"]);
  assert.deepEqual(JSON.parse(result.stdout), {
    statuses: ["unavailable", "unavailable"],
    github: false,
    cloudflare: false,
    npm: false,
  });
  const readonly = await run(
    `
    const result=await applicationRecoveryChannel('verify-existing').verifyExisting();
    console.log(result.status);
  `,
    {
      mode: "verify-existing",
      bridge: {
        async verifyExisting() {
          calls.push("read-only");
          return { status: "unavailable", reason: "Transport fixture; no retained lineage" };
        },
      },
    },
  );
  assert.equal(readonly.code, 0, readonly.stderr);
  assert.equal(readonly.rejection, "");
  assert.equal(readonly.stdout.trim(), "unavailable");
  assert.deepEqual(calls, ["before", "after", "read-only"]);
});

test("wrong checkpoint paths and read-only channel writes fail before a trusted handler runs", async () => {
  const unattached = await execute(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import {applicationRecoveryChannel} from ${JSON.stringify(moduleUrl)};
    try { applicationRecoveryChannel('perform'); throw Error('No channel required'); }
    catch(error) { if(!String(error).includes('Inherited application recovery channel required'))throw error; console.log('no-implicit-channel'); }
  `,
    ],
    repository,
    childEnvironment({ FORTIPI_RECOVERY_MODE: "perform" }),
  );
  assert.equal(unattached.code, 0);
  assert.equal(unattached.stdout.trim(), "no-implicit-channel");
  let calls = 0;
  const bridge: ApplicationRecoveryBridge = {
    async perform() {
      calls++;
      throw new Error("Unexpected provider call");
    },
    async finish() {
      calls++;
      throw new Error("Unexpected finish call");
    },
  };
  const escaped = await run(
    `
    try { await applicationRecoveryChannel('perform').perform(${JSON.stringify({ ...before, path: resolve(directory, "../foreign.json") })}); throw Error('Accepted escape'); }
    catch(error) { if(!String(error).includes('response rejected'))throw error; console.log('rejected'); }
  `,
    { mode: "perform", bridge },
  );
  assert.equal(escaped.code, 0, escaped.stderr);
  assert.match(escaped.rejection, /channel rejected/);
  const readonly = await run(
    `
    try { await applicationRecoveryChannel('perform').perform(${JSON.stringify(before)}); throw Error('Accepted provider write'); }
    catch(error) { if(!String(error).includes('response rejected'))throw error; console.log('rejected'); }
  `,
    {
      mode: "verify-existing",
      bridge: {
        async verifyExisting() {
          calls++;
          throw new Error("Unexpected verify");
        },
      },
    },
  );
  assert.equal(readonly.code, 0, readonly.stderr);
  assert.match(readonly.rejection, /channel rejected/);
  assert.equal(calls, 0);
});

test("provider errors and accidentally credential-bearing replies stay in the trusted process", async () => {
  for (const secret of [
    "synthetic-private-cloudflare-canary-value",
    'synthetic-quote"and-backslash\\-newline\n-canary',
  ])
    for (const throws of [false, true]) {
      const result = await run(
        `
      try { await applicationRecoveryChannel('perform').perform(${JSON.stringify(before)}); throw Error('Leaked response'); }
      catch(error) { if(!String(error).includes('response rejected'))throw error; console.log(String(error)); }
    `,
        {
          mode: "perform",
          bridge: {
            async perform() {
              if (throws) throw new Error(secret);
              return { status: "unavailable", reason: secret };
            },
            async finish() {
              throw new Error("Unexpected finish");
            },
          },
        },
        [secret],
      );
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.rejection, /channel rejected/);
      assert.equal(`${result.stdout}${result.stderr}${result.rejection}`.includes(secret), false);
    }
});
