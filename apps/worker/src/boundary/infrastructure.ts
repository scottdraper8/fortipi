import type { AuthContext, CapacityReservation, Outcome } from "./dto.js";

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
