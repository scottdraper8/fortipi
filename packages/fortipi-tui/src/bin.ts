#!/usr/bin/env node
import { isAbsolute } from "node:path";
import { FortiPiClient, FortiPiError } from "fortipi-client/node";
import { Controller } from "./controller.js";
import { applicationCredential } from "./credentials.js";
import type { Profile } from "./profiles.js";
import { loadProfiles, saveProfiles } from "./profiles.js";
import { smoke } from "./smoke.js";
import { runTerminal } from "./terminal.js";

const usage = `fortipi-tui [--profiles-file PATH] [--profile NAME] [--conversation ID] [--no-animation] [--smoke]
Application credentials only. No token arguments. Configure protected profiles.json and a per-origin client credential file; see README.
--profiles-file selects an absolute protected profile file; updates are saved to that same file.
--smoke performs ticket subscribe, committed completion, offline activity and cursor replay with a 120-second deadline.`;
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage);
    return;
  }
  let profileName: string | undefined,
    conversationId: string | undefined,
    profilesFile: string | undefined;
  let noAnimation = false,
    runSmoke = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--profiles-file") {
      const value = args[++i];
      if (
        profilesFile ||
        !value ||
        !isAbsolute(value) ||
        value.length > 4096 ||
        value.includes("\0")
      )
        throw new FortiPiError("invalid_arguments");
      profilesFile = value;
    } else if (arg === "--profile" || arg === "--conversation") {
      const value = args[++i];
      if (!value || !/^[A-Za-z0-9_-]{1,128}$/.test(value))
        throw new FortiPiError("invalid_arguments");
      if (arg === "--profile") profileName = value;
      else conversationId = value;
    } else if (arg === "--no-animation") noAnimation = true;
    else if (arg === "--smoke") runSmoke = true;
    else throw new FortiPiError("invalid_arguments");
  }
  const profiles = await loadProfiles(profilesFile);
  const profile = profileName
    ? profiles.profiles.find((p) => p.name === profileName)
    : profiles.profiles[0];
  if (!profile) throw new FortiPiError("profile_required");
  let activeProfile = profile;
  function client(p: Profile): FortiPiClient {
    return new FortiPiClient({
      endpoint: p.endpoint,
      allowLoopbackHttp: p.allowLoopbackHttp ?? false,
      credentials: ({ endpoint }) => applicationCredential(p.credentialFile, endpoint),
    });
  }
  const controller = new Controller(client(profile));
  controller.agentId = profile.agentId;
  if (runSmoke) {
    await smoke(controller, {
      ...(profile.agentId ? { agentId: profile.agentId } : {}),
      ...((conversationId ?? profile.conversationId)
        ? { conversationId: conversationId ?? (profile.conversationId as string) }
        : {}),
      observe: (phase, ids) => console.log(JSON.stringify({ phase, ...ids })),
    });
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new FortiPiError("interactive_terminal_required");
  const observeFd =
    process.env.FORTIPI_TUI_OBSERVE_FD === undefined
      ? undefined
      : Number(process.env.FORTIPI_TUI_OBSERVE_FD);
  // Mount keyboard handling before potentially slow network activity, so switching/cancel remains available.
  const terminal = runTerminal(controller, {
    profileName: profile.name,
    noAnimation,
    ...(observeFd === undefined ? {} : { observeFd }),
    profiles: {
      names: profiles.profiles.map((p) => p.name),
      select: async (name) => {
        const selected = profiles.profiles.find((p) => p.name === name);
        if (!selected) throw new FortiPiError("profile_required");
        controller.changeClient(client(selected));
        activeProfile = selected;
        controller.agentId = selected.agentId;
      },
    },
  });
  void (
    (conversationId ?? profile.conversationId)
      ? controller.open(conversationId ?? (profile.conversationId as string))
      : controller.browse("agents")
  ).catch((error) => {
    if (!(error instanceof FortiPiError && error.code === "aborted")) controller.report(error);
  });
  await terminal;
  if (controller.agentId) activeProfile.agentId = controller.agentId;
  if (controller.conversationId) activeProfile.conversationId = controller.conversationId;
  else delete activeProfile.conversationId;
  await saveProfiles(profiles, profilesFile);
}
void main().catch((error) => {
  console.error(error instanceof FortiPiError ? error.message : "FortiPi: startup_failed");
  process.exitCode = 1;
});
