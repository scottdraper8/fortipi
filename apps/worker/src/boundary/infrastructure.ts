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
