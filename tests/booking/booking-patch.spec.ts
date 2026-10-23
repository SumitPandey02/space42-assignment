import { test, expect } from '../../src/fixtures/api.fixture';

test.describe('PATCH drift control @core', () => {
  test('updating only totalprice leaves every other field untouched', async ({
    bookingApi,
    factory,
    cleanup,
  }) => {
    const created = await cleanup.create(bookingApi, factory.build());
    const original = await bookingApi.getById(created.bookingid);

    const updated = await bookingApi.patch(created.bookingid, {
      totalprice: original.totalprice + 77,
    });

    expect(updated.totalprice).toBe(original.totalprice + 77);
    expect(updated.firstname).toBe(original.firstname);
    expect(updated.lastname).toBe(original.lastname);
    expect(updated.bookingdates).toEqual(original.bookingdates);
    expect(updated.depositpaid).toBe(original.depositpaid);
    expect(updated.additionalneeds).toBe(original.additionalneeds);

    const persisted = await bookingApi.getById(created.bookingid);
    expect(persisted).toEqual(updated);
  });
});
