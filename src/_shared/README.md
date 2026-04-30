# `_shared` — single source of truth across all role-views

This directory is **mirrored byte-for-byte** between the mobile, server,
and admin-web repos. Code here gets imported by all three. The point
is to prevent drift between status enums, socket event names, transition
matrices, and shared helpers — drift that has caused the "rider pin not
showing", "customer sees X but rider sees Y", and "active-order whitelist
forgot a state" bug class repeatedly.

## Where it lives

| Repo                         | Path                       |
| ---------------------------- | -------------------------- |
| mobile/gaznger               | `_shared/`                 |
| server                       | `src/_shared/`             |
| admin-web (when adopted)     | `src/_shared/`             |

The leading underscore matters: TypeScript path mapping (when set up)
treats `_shared` as a non-route directory in Expo Router, and the
underscore makes it sortable to the top in file lists.

## Sync rule

The **mobile copy is canonical.** Edit there first; then run
`scripts/sync-shared.mjs` from the mobile repo to mirror the directory
into the server (and admin-web when adopted).

```bash
cd mobile/gaznger
node scripts/sync-shared.mjs
```

The sync script:
1. Copies every file in `_shared/` to `../../server/src/_shared/`.
2. Reports any files in the destination that aren't in the source
   (so you know if the destination has drifted manually).

## What goes in here

✅ Yes:
- TypeScript types and enums shared across client + server.
- Pure functions with no platform deps (no React, no Express, no Mongoose).
- Socket event name constants + payload type definitions.
- The status-transition matrix (single source of truth).
- Constants: timeouts, status sets, points awards.

❌ No:
- Anything importing from `react-native`, `react`, `mongoose`,
  `express`, etc.
- Anything that touches the network or the filesystem.
- Anything theme- or design-system-related (those stay per-platform).

## Files

| File              | Purpose                                                          |
| ----------------- | ---------------------------------------------------------------- |
| `status.ts`       | Order + Delivery status enums + active-status sets.              |
| `transitions.ts`  | Status transition matrix (rider/vendor/customer roles).          |
| `trackPhase.ts`   | `TrackPhase` + `getTrackPhase` — server-status → customer phase. |
| `socketEvents.ts` | Socket event name constants + payload types.                     |
| `format.ts`       | `formatCurrency`, `formatLitres`, `formatKobo` helpers.          |
| `idempotency.ts`  | `newIdempotencyKey` (RFC 4122 v4 UUID).                          |
| `index.ts`        | Re-exports everything for convenient imports.                    |
