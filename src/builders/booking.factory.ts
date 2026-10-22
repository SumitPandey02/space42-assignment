/**
 * Test-data factory.
 *
 * Every booking gets a name containing the run id, the worker index and a
 * monotonic sequence. That makes leaked records attributable to a specific run
 * and worker, and guarantees two parallel tests never accidentally share
 * first/last names (which would pollute filter assertions).
 *
 * Dates are relative to "today" and therefore never expire. The default room
 * and date window are derived from worker + sequence so unrelated tests do not
 * collide, while tests that *want* an overlap can pass an explicit room/dates.
 */

import type {
  Booking,
  BookingCreateInput,
  BookingDates,
  BookingUpdateInput,
} from '../contracts/booking.schema';
import { createDateRange, type DateRange } from '../utils/date-utils';
import { Sequence, uniqueName } from '../utils/run-id';

export interface BookingFactoryOptions {
  readonly workerIndex: number;
  /** Anchor for relative dates; injected in unit tests for determinism. */
  readonly from?: Date;
}

export type BookingOverrides = Omit<Partial<BookingCreateInput>, 'bookingdates'> & {
  readonly bookingdates?: Partial<BookingDates>;
  readonly startOffsetDays?: number;
  readonly nights?: number;
};

export class BookingFactory {
  private readonly sequence = new Sequence();

  constructor(private readonly options: BookingFactoryOptions) {}

  /** A fully valid create payload. Callers may override any field. */
  build(overrides: BookingOverrides = {}): BookingCreateInput {
    const sequence = this.sequence.next();
    const worker = this.options.workerIndex;

    const range: DateRange = createDateRange({
      startOffsetDays: overrides.startOffsetDays ?? 30 + worker * 60 + sequence,
      nights: overrides.nights ?? 2 + (sequence % 3),
      ...(this.options.from === undefined ? {} : { from: this.options.from }),
    });

    const base: BookingCreateInput = {
      firstname: uniqueName('Shaun', worker, sequence),
      lastname: uniqueName('Brown', worker, sequence),
      totalprice: 100 + sequence * 7,
      depositpaid: sequence % 2 === 0,
      bookingdates: { checkin: range.checkin, checkout: range.checkout },
      additionalneeds: 'Breakfast',
      roomid: 1_000 + worker * 1_000 + sequence,
    };

    return {
      ...base,
      ...overrides,
      bookingdates: { ...base.bookingdates, ...overrides.bookingdates },
    };
  }

  /** Full replacement payload derived from a persisted booking (PUT semantics). */
  static toUpdatePayload(booking: Booking): BookingUpdateInput {
    return {
      firstname: booking.firstname,
      lastname: booking.lastname,
      totalprice: booking.totalprice,
      depositpaid: booking.depositpaid,
      bookingdates: { ...booking.bookingdates },
      ...(booking.additionalneeds === undefined ? {} : { additionalneeds: booking.additionalneeds }),
      ...(booking.roomid === undefined ? {} : { roomid: booking.roomid }),
    };
  }
}
