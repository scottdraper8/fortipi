import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Terminal } from "@earendil-works/pi-tui";
import {
  Editor,
  ProcessTerminal,
  ScrollView,
  SelectList,
  Text,
  TuiAltScreen,
  VStack,
} from "@earendil-works/pi-tui";
import { FortiPiError } from "fortipi-client/node";
import { copyText } from "./clipboard.js";
import type { Controller } from "./controller.js";
import { navigation } from "./keys.js";
import { observer } from "./observation.js";
import { content, header, sanitize } from "./views.js";

const plain = (text: string) => text;
const listTheme = {
  selectedPrefix: plain,
  selectedText: plain,
  description: plain,
  scrollInfo: plain,
  noMatch: plain,
};
export interface TerminalOptions {
  profileName: string;
  noAnimation?: boolean;
  terminal?: Terminal;
  observeFd?: number;
  profiles?: { names: string[]; select(name: string): Promise<void> };
}
/** Both real keyboard input and component tests call the same controller methods. */
export async function runTerminal(controller: Controller, options: TerminalOptions): Promise<void> {
  const tui = new TuiAltScreen(options.terminal ?? new ProcessTerminal(), true, undefined, {
    openUrl: () => {},
    copySelection: async (text) => {
      const result = await copyText(text);
      return result.ok || result.message;
    },
  });
  const title = new Text("", 0, 0);
  const body = new Text("", 0, 0);
  const scroll = new ScrollView(body, {
    primary: true,
    follow: "end",
    scrollbar: "always",
    scrollbarHideDelayMs: 0,
  });
  const editor = new Editor(tui, { borderColor: plain, selectList: listTheme });
  const foot = new Text("Tab focus | /help | /agents | /quit", 0, 0);
  let list = new SelectList([], 8, listTheme);
  let choicesKey = "";
  let focus = 0;
  let profileName = options.profileName;
  const observe = observer(options.observeFd);
  let finish: () => void = () => {};
  const done = new Promise<void>((resolveDone) => {
    finish = resolveDone;
  });
  let renderingError: FortiPiError | undefined;
  const render = () => {
    title.setText(
      header(controller, profileName, ["composer", "list", "transcript"][focus] ?? "composer"),
    );
    body.setText(content(controller));
    const key = JSON.stringify(controller.choices);
    if (key !== choicesKey) {
      choicesKey = key;
      list = new SelectList(
        controller.choices.map((choice) => ({
          value: choice.id,
          label: sanitize(choice.title),
          description: choice.id,
        })),
        8,
        listTheme,
      );
      list.onSelect = (choice) => {
        void action(async () => {
          if (controller.view === "profiles" && options.profiles) {
            await options.profiles.select(choice.value);
            profileName = choice.value;
            await controller.browse("agents");
          } else {
            await controller.choose(choice.value);
            if (controller.view === "conversation") focus = 0;
          }
        });
      };
    }
    if (editor.getText() !== controller.composer) editor.setText(controller.composer);
    const root = new VStack([
      { component: title, shrink: 0 },
      { component: list, maxSize: controller.choices.length ? 8 : 0, shrink: 0 },
      { component: scroll, grow: 1, minSize: 2 },
      { component: editor, maxSize: 8, shrink: 0 },
      { component: foot, shrink: 0 },
    ]);
    tui.setLayoutRoot(root);
    tui.setFocus(focus === 0 ? editor : focus === 1 ? list : body);
    tui.requestRender();
    observe(controller, ["composer", "list", "transcript"][focus] ?? "composer");
  };
  const draw = () => {
    try {
      render();
    } catch {
      renderingError = new FortiPiError("terminal_render_failed");
      finish();
    }
  };
  async function action(run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (error) {
      if (!(error instanceof FortiPiError && error.code === "aborted")) controller.report(error);
    } finally {
      draw();
    }
  }
  async function command(value: string): Promise<void> {
    if (!value.startsWith("/")) {
      controller.composer = value;
      await controller.send();
      return;
    }
    const [name, ...args] = value.trim().split(/\s+/);
    const text = args.join(" ");
    // Commands do not replace an uncertain message intent or erase rejected content.
    controller.composer = "";
    switch (name) {
      case "/agents":
        await controller.browse("agents", text);
        focus = 1;
        break;
      case "/conversations":
        await controller.browse("conversations", text);
        focus = 1;
        break;
      case "/more":
        if (controller.view === "agents" || controller.view === "conversations")
          await controller.browse(controller.view, "", true);
        break;
      case "/new":
        await controller.create(text || undefined);
        focus = 0;
        break;
      case "/open":
        await controller.open(args[0] ?? "");
        focus = 0;
        break;
      case "/steer":
        controller.composer = text;
        await controller.send("steer");
        break;
      case "/retry":
        await controller.retryIntent();
        break;
      case "/tool":
        controller.tool(args[0] ?? "");
        focus = 2;
        break;
      case "/transaction":
        await controller.transact(
          args[0] ?? "",
          JSON.parse(args.slice(1).join(" ")) as import("fortipi-contract").WorkspaceTransaction,
        );
        break;
      case "/status":
        controller.view = "workspace";
        controller.detail = JSON.stringify(controller.client.http.protocol, null, 2);
        focus = 2;
        break;
      case "/discard-intent":
        controller.discardIntent();
        break;
      case "/task":
        await controller.task(args[0]);
        break;
      case "/cancel":
        await controller.cancel(args[0]);
        break;
      case "/resume":
        if (!["next-submit", "retry-approved", "resume"].includes(args[1] ?? ""))
          throw new FortiPiError("invalid_continuation");
        await controller.resume(args[0] ?? "", args[1] as "resume");
        break;
      case "/approvals":
        if (args[0]) await controller.approval(args[0]);
        else controller.listApprovals();
        focus = args[0] ? 2 : 1;
        break;
      case "/approve":
        await controller.decide("approve");
        break;
      case "/reject":
        await controller.decide("reject");
        break;
      case "/reconcile":
        await controller.job(args[0]);
        focus = 2;
        break;
      case "/ack-unknown":
        await controller.reconcile({ kind: "acknowledge-unknown" }, text);
        break;
      case "/ack-failed":
        await controller.reconcile({ kind: "acknowledge-failed" }, text);
        break;
      case "/discard-staging":
        await controller.reconcile({ kind: "discard-staging" }, text);
        break;
      case "/accept-result": {
        const job = controller.selectedJob;
        if (!job?.preparedResult || !job.receipt)
          throw new FortiPiError("verified_result_receipt_required");
        await controller.reconcile(
          { kind: "accept-result", result: job.preparedResult, receipt: job.receipt },
          text,
        );
        break;
      }
      case "/new-job":
        await controller.reconcile(
          { kind: "new-job", newJobId: args[0] ?? "", authorizationId: args[1] ?? "" },
          args.slice(2).join(" "),
        );
        break;
      case "/workspace":
        await controller.workspace(args[0] ?? "");
        focus = 2;
        break;
      case "/diff":
        await controller.diff(args[0] ?? "", args[1] ?? "", args[2] ?? "");
        break;
      case "/read":
        await controller.read(args[0] ?? "", args[1] ?? "", args.slice(2).join(" "));
        break;
      case "/artifact": {
        const reference = controller.projection.artifacts.get(args[0] ?? "");
        if (!reference) throw new FortiPiError("artifact_id_required");
        const bytes = await controller.client.artifacts.read(reference);
        if (args[1]) {
          await writeFile(resolve(args.slice(1).join(" ")), bytes, { flag: "wx", mode: 0o600 });
          controller.notice = "Artifact saved (new file)";
        } else {
          controller.view = "workspace";
          controller.detail = `${reference.size} bytes; bounded preview:\n${new TextDecoder().decode(bytes.slice(0, 32768))}`;
        }
        break;
      }
      case "/ids":
        controller.view = "ids";
        focus = 2;
        break;
      case "/copy":
        controller.notice = (await copyText(controller.ids())).message;
        break;
      case "/profiles":
        controller.view = "profiles";
        controller.choices = (options.profiles?.names ?? []).map((name) => ({
          id: name,
          title: name,
        }));
        focus = 1;
        break;
      case "/disconnect":
        await controller.disconnect();
        break;
      case "/reconnect":
        await controller.reconnect();
        break;
      case "/resnapshot":
        await controller.resnapshot();
        break;
      case "/help":
        controller.view = "help";
        focus = 2;
        break;
      case "/quit":
        finish();
        break;
      default:
        throw new FortiPiError("unknown_command");
    }
    controller.changed();
  }
  // Upstream clears its editor on submit; restore controller composer after rejection.
  editor.onChange = (value) => {
    controller.composer = value;
  };
  editor.onSubmit = (value) => {
    void action(() => command(value));
  };
  const unlisten = controller.listen(draw);
  const removeInput = tui.addInputListener((data) => {
    const key = navigation(data);
    if (key === "quit") {
      finish();
      return { consume: true };
    }
    if (key === "next" || key === "previous") {
      focus = (focus + (key === "next" ? 1 : 2)) % 3;
      draw();
      return { consume: true };
    }
    if (key === "escape") {
      controller.stopSearch();
      if (tui.hasOverlay()) tui.hideOverlay();
      else {
        controller.view = "conversation";
        controller.choices = [];
        focus = 0;
      }
      draw();
      return { consume: true };
    }
    if (key === "page-up" || key === "page-down") {
      scroll.scrollBy(key === "page-up" ? -12 : 12);
      tui.requestRender();
      return { consume: true };
    }
    return undefined;
  });
  const terminate = () => finish();
  const fail = () => {
    renderingError = new FortiPiError("terminal_failed");
    finish();
  };
  process.once("SIGINT", terminate);
  process.once("SIGTERM", terminate);
  process.once("SIGHUP", terminate);
  process.once("uncaughtException", fail);
  process.once("unhandledRejection", fail);
  try {
    draw();
    tui.start();
    await done;
    if (renderingError) throw renderingError;
  } finally {
    controller.close();
    unlisten();
    removeInput();
    observe.close();
    process.removeListener("SIGINT", terminate);
    process.removeListener("SIGTERM", terminate);
    process.removeListener("SIGHUP", terminate);
    process.removeListener("uncaughtException", fail);
    process.removeListener("unhandledRejection", fail);
    tui.stop();
  }
}
