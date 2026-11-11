import type {
  OperationId,
  OperationRequest,
  OperationValue,
  Protocol,
  TicketIdentity,
} from "fortipi-contract";

export type CredentialReason = "initial" | "unauthenticated";
export type CredentialProvider = (context: {
  endpoint: string;
  signal: AbortSignal;
  reason: CredentialReason;
}) => Promise<string>;
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: SocketEvent) => void): void;
  removeEventListener(type: string, listener: (event: SocketEvent) => void): void;
}
export interface SocketEvent {
  data?: unknown;
  code?: number;
}
export type SocketFactory = (url: string) => SocketLike;
export interface ClientOptions {
  endpoint: string;
  credentials: CredentialProvider;
  fetch?: typeof globalThis.fetch;
  webSocket?: SocketFactory;
  /** Explicitly enable unencrypted loopback for local development. */
  allowLoopbackHttp?: boolean;
  /** Browser defaults to location.origin. Node entry defaults to native/no-Origin. */
  originMode?: { kind: "browser"; origin: string } | { kind: "native" };
  timeoutMs?: number;
  requiredFeatures?: readonly string[];
  random?: () => number;
}
export interface RequestOptions {
  signal?: AbortSignal;
  range?: { start: number; end?: number };
}
export type OperationInput<K extends OperationId> = Omit<OperationRequest<K>, "operationId">;
export interface CursorScope {
  origin: string;
  conversationId: string;
  identity: TicketIdentity;
}
export interface UpgradeConnection {
  socket: SocketLike;
  close(): void;
}
export type UpgradeOperation = "getClientStream" | "getExecutorSession";
export type Operations = {
  [K in OperationId]: (
    input: OperationInput<K>,
    options?: RequestOptions,
  ) => Promise<K extends UpgradeOperation ? UpgradeConnection : OperationValue<K>>;
};
export type ConnectionStatus =
  | "connecting"
  | "online"
  | "offline"
  | "reconnecting"
  | "resyncing"
  | "paused"
  | "closed";
export interface Negotiated {
  protocol: Protocol;
  origin: string;
}
export type {
  OperationId,
  OperationRequest,
  OperationResponse,
  OperationValue,
} from "fortipi-contract";
