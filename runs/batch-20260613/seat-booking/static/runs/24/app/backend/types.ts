// Type definitions for the seat-booking backend
// These are reference types; the backend runs as plain JavaScript.

export interface Seat {
  id: number;
  row_label: string;
  seat_number: number;
  status: "available" | "held" | "booked";
  hold_id: string | null;
  hold_expires_at: string | null;
  booked_by: string | null;
}

export interface Hold {
  id: string;
  session_id: string;
  seat_ids: number[];
  expires_at: string;
  status: "active" | "confirmed" | "released" | "expired";
  created_at: string;
  confirmed_at: string | null;
}

export interface EffectiveSeat {
  id: number;
  row_label: string;
  seat_number: number;
  status: "available" | "held" | "booked";
  hold_id: string | null;
  hold_expires_at: string | null;
}

export interface HoldRequest {
  seatIds: number[];
  sessionId: string;
}

export interface HoldResponse {
  holdId: string;
  seats: EffectiveSeat[];
  expiresAt: string;
}

export interface ConfirmResponse {
  holdId: string;
  seats: EffectiveSeat[];
  confirmedAt: string;
}

export interface ErrorResponse {
  error: string;
  conflictingSeatIds?: number[];
}
