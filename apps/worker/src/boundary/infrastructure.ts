import type { AuthContext, CapacityReservation, Outcome, StoreLookup } from "./dto.js";

/** Private registered-recipient input to CP.fetch POST /internal/storage-sample; closed JSON <=64KiB. */
export interface StorageSampleInput {
  sampleId: string;
  policyVersion: number;
  sampleSeq: number;
  observedAt: number;
  coverage:
    | { kind: "agent"; bytes: number }
    | { kind: "workspace"; bytes: number; censusVersion: number };
  /** At most100 unique bounded IDs of growth reservations preceding the queued sample barrier. */
  coveredReservationIds: string[];
}
export interface StorageSampleReceipt {
  sampleSeq: number;
  chargeBytes: number;
}
/** Private Workspace.fetch POST /__fortipi/storage-sample; metadata only, closed JSON <=64KiB. */
export type WorkspaceStorageSampleInput = {
  sampleId: string;
  policyVersion: number;
} & (
  | { kind: "authority"; lookup?: never; registryVersion?: never }
  | { kind: "child"; lookup: StoreLookup; registryVersion: number }
);
export type WorkspaceStorageSample = {
  sampleId: string;
  bytes: number;
  observedAt: number;
} & (
  | { kind: "authority"; lookup?: never; registryVersion?: never }
  | { kind: "child"; lookup: StoreLookup; registryVersion: number }
);

/** Private SDK launch assertions; the owned Host strips context before calling the original SDK. */
export const runtimeHostContextEnv = "FORTIPI_RUNTIME_HOST_CONTEXT";
export const runtimeHostOwnershipLabel = "fortipi_owner";
/** Private pool member retained before native Host contact; it outlives Computer child deletion. */
export interface RuntimeHostContext {
  /** Canonical linuxHostId using the actual child DO object ID; not a public identifier. */
  hostId: string;
  authorityId: string;
  allocationId: string;
  childId: string;
  imageDigest: string;
  /** Authority-issued 32-byte CSPRNG value encoded as 64 lowercase hexadecimal characters. */
  ownershipNonce: string;
}
/** Private LinuxContainerHost.fetch POST /__fortipi/storage-sample; closed JSON <=64KiB. */
export interface RuntimeHostStorageSampleInput {
  sampleId: string;
  policyVersion: number;
  context: RuntimeHostContext;
  /** Actual acknowledged SDK identity; unknown allocations retain prospective coverage. */
  runtimeId: string;
  registryVersion: number;
}
export interface RuntimeHostStorageSample {
  sampleId: string;
  context: RuntimeHostContext;
  runtimeId: string;
  registryVersion: number;
  /** Only this Host's public SQL database size; never its Computer child's size or an estimate. */
  bytes: number;
  observedAt: number;
}

export type {
  CapabilityStatus,
  CapacityReservation,
  InfrastructurePolicy,
  InfrastructurePressure,
} from "fortipi-contract";
export interface InfrastructureReservations {
  reserveCapacity(
    ctx: AuthContext,
    input: {
      operationId: string;
      ownerId: string;
      policyVersion: number;
      bytes: number;
      admissionSlots: number;
    },
  ): Promise<Outcome<CapacityReservation>>;
  settleCapacity(
    ctx: AuthContext,
    input: { reservationId: string; disposition: "consumed" | "unused"; observedBytes?: number },
  ): Promise<Outcome<CapacityReservation>>;
}
