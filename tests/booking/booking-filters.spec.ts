import { test, expect } from '../../src/fixtures/api.fixture';

test.describe('booking search filters @core', () => {
  test('finds the test-owned booking by unique first and last name', async ({
    bookingApi,
    factory,
    cleanup,
  }) => {
    const created = await cleanup.create(bookingApi, factory.build());
    const { firstname, lastname } = created.booking;

    const byFirst = await bookingApi.list({ firstname });
    const byLast = await bookingApi.list({ lastname });
    const byBoth = await bookingApi.list({ firstname, lastname });

    expect(byFirst.map((entry) => entry.bookingid)).toContain(created.bookingid);
    expect(byLast.map((entry) => entry.bookingid)).toContain(created.bookingid);
    expect(byBoth.map((entry) => entry.bookingid)).toContain(created.bookingid);
  });

  test('does not return the booking for a different unique name', async ({
    bookingApi,
    factory,
    cleanup,
  }) => {
    const created = await cleanup.create(bookingApi, factory.build());
    const other = factory.build();

    const results = await bookingApi.list({ firstname: other.firstname });
    expect(results.map((entry) => entry.bookingid)).not.toContain(created.bookingid);
  });
});
