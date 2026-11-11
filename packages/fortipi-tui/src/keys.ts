import { matchesKey } from "@earendil-works/pi-tui";
export type Navigation =
  | "next"
  | "previous"
  | "escape"
  | "quit"
  | "page-up"
  | "page-down"
  | undefined;
export function navigation(data: string): Navigation {
  if (matchesKey(data, "ctrl+c")) return "quit";
  if (matchesKey(data, "shift+tab")) return "previous";
  if (matchesKey(data, "tab")) return "next";
  if (matchesKey(data, "escape")) return "escape";
  if (matchesKey(data, "pageUp")) return "page-up";
  if (matchesKey(data, "pageDown")) return "page-down";
  return undefined;
}
