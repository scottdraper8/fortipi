/** Portable terminal adapter; keeps CLI declarations independent of provider SDK internals. */
export type InteractionPrompt = { signal?: AbortSignal } & (
  | { type: "text" | "secret" | "manual_code"; message: string; placeholder?: string }
  | {
      type: "select";
      message: string;
      options: readonly { id: string; label: string; description?: string }[];
    }
);
export type InteractionEvent =
  | { type: "info"; message: string; links?: readonly { url: string; label?: string }[] }
  | { type: "auth_url"; url: string; instructions?: string }
  | {
      type: "device_code";
      verificationUri: string;
      userCode: string;
      openBrowserOnConfirm?: boolean;
      copyCodeOnConfirm?: boolean;
      intervalSeconds?: number;
      expiresInSeconds?: number;
    }
  | { type: "progress"; message: string };
export interface CliInteraction {
  signal?: AbortSignal;
  prompt(prompt: InteractionPrompt): Promise<string>;
  notify(event: InteractionEvent): void | Promise<void>;
}
