# Phase 6 — Granular pipeline E2E test plan

This document describes the end-to-end test that should run in CI to
verify the customer + rider state machines stay in lockstep through
the full v3 granular pipeline. Implementation is queued — the
infrastructure (test Mongo, multi-socket harness) is the same gap
that's blocked the existing test suite, so this lands when that's
in place.

## Goal

Given a real Express server + real Mongo + two socket.io clients
(customer + rider), exercise the full delivery flow and assert at
each step that:

1. Server returns the expected `delivery.status` on the rider's
   `GET /api/rider/active`.
2. Server returns the expected `order.status` on the customer's
   `GET /api/orders/:id`.
3. The customer socket received an `order:update` with the new
   status within 1 second of the rider's PATCH.
4. The rider socket received a `delivery:update` with the new
   status within 1 second of its own PATCH.
5. Both sockets are members of the same `delivery:<id>` room.

## Setup

- Spin up the server pointed at a test Mongo (separate db from dev).
- Seed: 1 GasStation, 1 Vendor user, 1 Rider user with profile, 1
  Customer user.
- Generate JWT tokens for the rider + customer.
- Connect two socket.io clients with `auth: { token }` for each role.

## Test sequence (liquid order, full granular ladder)

| Step | Actor    | Action                                                  | Expected status (Order / Delivery) |
| ---- | -------- | ------------------------------------------------------- | ---------------------------------- |
| 1    | Customer | `POST /api/orders` (place order, paid)                  | `pending` / —                      |
| 2    | Vendor   | `PATCH /api/orders/:id/status` confirmed                | `confirmed` / —                    |
| 3    | System   | Dispatch (auto)                                         | `assigned` / `pending`             |
| 4    | Rider    | `PATCH /api/rider/deliveries/:id/accept`                | `assigned` / `accepted`            |
| 5    | Rider    | `PATCH /api/rider/deliveries/:id/at-plant`              | `at_plant` / `at_plant`            |
| 6    | Rider    | `PATCH /api/rider/deliveries/:id/refilling`             | `refilling` / `refilling`          |
| 7    | Rider    | `PATCH /api/rider/deliveries/:id/heading-back`          | `returning` / `returning`          |
| 8    | Rider    | `PATCH /api/rider/deliveries/:id/arrived`               | `arrived` / `arrived`              |
| 9    | Rider    | `PATCH /api/rider/deliveries/:id/dispensing`            | `dispensing` / `dispensing`        |
| 10   | Rider    | `PATCH /api/rider/deliveries/:id/finalise`              | `awaiting_confirmation` / `awaiting_confirmation` |
| 11   | Customer | `PATCH /api/orders/:id/confirm-delivery`                | `delivered` / `delivered`          |

## Per-step assertions

After every PATCH:

```ts
// Both sides should see the same status (Phase 5 lockstep)
const rider = await api.get(`/api/rider/active`, riderToken);
const order = await api.get(`/api/orders/${orderId}`, customerToken);
expect(rider.delivery.status).toBe(expectedDelivery);
expect(order.status).toBe(expectedOrder);

// Customer socket received order:update within 1s
const customerEvt = await waitFor(customerSocket, "order:update", 1000);
expect(customerEvt.status).toBe(expectedOrder);

// Rider socket received delivery:update within 1s
const riderEvt = await waitFor(riderSocket, "delivery:update", 1000);
expect(riderEvt.status).toBe(expectedDelivery);
```

## Reconnect-catchup assertion (Phase 2)

Mid-pipeline (after step 6):
1. Force-disconnect the customer socket.
2. Rider continues through steps 7–9 (3 events the customer misses).
3. Reconnect the customer socket.
4. Within 2 seconds, the customer's local state should match
   `order.status === "dispensing"` (verified by re-fetching
   `/api/orders/:id` from the customer's app, which Phase 2's
   `subscribeReconnect` callback fires automatically).

## Concurrency assertion (Phase 9)

1. Two rider sockets attempt `PATCH .../accept` for the same
   pending Delivery in parallel (Promise.all).
2. Exactly one returns 200; the other returns 404 (no longer
   matches the `status: "pending"` filter on findOneAndUpdate).
3. Order.status is `assigned`, not corrupted.

## Drift assertion (Phase 5)

After step 10, run `npm run reconcile:status` against the test db.
The script should report 0 drifts (all in-flight orders have
matching Order/Delivery status).

## Out of scope

- LPG-Swap shortcut paths (at_plant → returning, arrived →
  awaiting_confirmation). Should be a separate test once liquid
  passes.
- Push notification delivery (requires APNs/FCM dev environment).
- Network partitioning beyond a single forced disconnect.

## Implementation notes

- Use `socket.io-client` for the test clients.
- `waitFor(socket, event, timeout)` helper: returns a Promise that
  resolves with the next event payload or rejects on timeout.
- Test runner: vitest or jest, whichever the team adopts.
- Each test cleans up: `Order.deleteMany`, `Delivery.deleteMany` on
  the seeded order ids.
