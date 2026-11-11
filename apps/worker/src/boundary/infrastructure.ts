import type { AuthContext, CapacityReservation, Outcome } from "./dto.js";

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
