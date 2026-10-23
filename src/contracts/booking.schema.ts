import { z } from 'zod';

/**
 * Booking contracts.
 *
 * `z.iso.date()` validates both the `YYYY-MM-DD` shape and real calendar
 * validity (2027-02-30 is rejected), which `new Date()` would silently roll over.
 * The nested `bookingdates` object carries the checkout-after-checkin invariant,
 * so every parsed booking is guaranteed to satisfy it - including responses we
 * never requested ourselves.
 */

const isoDate = z.iso.date();

export const bookingDatesSchema = z
  .object({
    checkin: isoDate,
    checkout: isoDate,
  })
  .refine((value) => value.checkout > value.checkin, {
    message: 'checkout must be strictly after checkin',
    path: ['checkout'],
  });

const bookingBaseSchema = z.object({
  firstname: z.string().min(1),
  lastname: z.string().min(1),
  totalprice: z.number().finite(),
  depositpaid: z.boolean(),
  bookingdates: bookingDatesSchema,
  additionalneeds: z.string().optional(),
  /**
   * Optional on purpose: the public sandbox accepts `roomid` on write but
   * silently drops it, so it is absent from every subsequent GET.
   */
  roomid: z.number().int().positive().optional(),
});

/** Full booking body as returned by the API. */
export const bookingSchema = bookingBaseSchema;

/** Full create/PUT payload. */
export const bookingCreateSchema = bookingBaseSchema;
export const bookingUpdateSchema = bookingBaseSchema;

/** PATCH payload: every field is optional, unknown fields are stripped. */
export const bookingPatchSchema = bookingBaseSchema.partial();

export const bookingResponseSchema = z.object({
  bookingid: z.number().int().positive(),
  booking: bookingSchema,
});

export const bookingSummarySchema = z.object({
  bookingid: z.number().int().positive(),
});

export const bookingListSchema = z.array(bookingSummarySchema);

export type BookingDates = z.infer<typeof bookingDatesSchema>;
export type Booking = z.infer<typeof bookingSchema>;
export type BookingCreateInput = z.infer<typeof bookingCreateSchema>;
export type BookingUpdateInput = z.infer<typeof bookingUpdateSchema>;
export type BookingPatchInput = z.infer<typeof bookingPatchSchema>;
export type BookingResponse = z.infer<typeof bookingResponseSchema>;
export type BookingSummary = z.infer<typeof bookingSummarySchema>;
