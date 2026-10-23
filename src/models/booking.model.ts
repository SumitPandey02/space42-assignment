/**
 * Domain models.
 *
 * Types are *derived* from the Zod contracts (`z.infer`); they are never
 * hand-written. That guarantees the compile-time type and the runtime validator
 * can never drift apart - the classic failure mode of "I typed an interface, so
 * I trusted the JSON".
 */

import type {
  Booking,
  BookingCreateInput,
  BookingDates,
  BookingPatchInput,
  BookingResponse,
  BookingSummary,
  BookingUpdateInput,
} from '../contracts/booking.schema';

export type {
  Booking,
  BookingCreateInput,
  BookingDates,
  BookingPatchInput,
  BookingResponse,
  BookingSummary,
  BookingUpdateInput,
};

/** Booking without the environment-specific `roomid` field. */
export type NormalisedBooking = Omit<Booking, 'roomid'>;

/**
 * Strip optional/environment-specific fields so that a booking fetched from the
 * real API (which omits `roomid`) can be compared with the payload we sent.
 */
export function normaliseBooking(booking: Booking): NormalisedBooking {
  const { firstname, lastname, totalprice, depositpaid, bookingdates, additionalneeds } = booking;

  return {
    firstname,
    lastname,
    totalprice,
    depositpaid,
    bookingdates,
    ...(additionalneeds === undefined ? {} : { additionalneeds }),
  };
}

/** Fields that a PATCH is allowed to modify without touching anything else. */
export const MUTABLE_BOOKING_FIELDS = [
  'firstname',
  'lastname',
  'totalprice',
  'depositpaid',
  'bookingdates',
  'additionalneeds',
] as const;

export type MutableBookingField = (typeof MUTABLE_BOOKING_FIELDS)[number];
