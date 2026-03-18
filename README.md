# Gaznger — Backend API

> **Version 2.0** | Node.js / Express REST API powering the Gaznger multi-role fuel delivery platform.

This service handles all platform operations: authentication, multi-role order management, vendor station control, rider dispatch, delivery tracking, earnings settlement, loyalty points, Paystack payments, FCM push notifications, Resend transactional email, and Cloudinary image storage.

---

## Table of Contents

- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [API Reference](#api-reference)
- [Data Models](#data-models)
- [Authentication Flow](#authentication-flow)
- [Dispatch System](#dispatch-system)
- [Payment Flow](#payment-flow)
- [Middleware](#middleware)
- [Background Jobs](#background-jobs)
- [Setup & Running](#setup--running)
- [Environment Variables](#environment-variables)
- [Known Limitations & TODO](#known-limitations--todo)

---

## Tech Stack

| Concern | Library | Version |
|---------|---------|---------|
| Runtime | Node.js | 18+ |
| Language | TypeScript | ^5.9 |
| Framework | Express | ^5.2 |
| Database | MongoDB Atlas · Mongoose | ^9.1 |
| Auth | jsonwebtoken | ^9.0 |
| Password Hashing | bcrypt | ^6.0 |
| Validation | zod | ^4.3 |
| File Upload | multer | ^2.0 |
| Image Storage | Cloudinary SDK | ^2.8 |
| Push Notifications | firebase-admin (FCM) | ^13.6 |
| Email | Resend | ^6.9 |
| Payments | Paystack REST API | — |
| Background Jobs | node-cron | ^4.2 |
| Security | helmet · express-rate-limit | — |
| API Docs | swagger-ui-express + swagger-jsdoc | — |
| Dev Server | ts-node-dev | — |

---

## Project Structure

```
server/
├── src/
│   ├── index.ts                   # Entry: load env, connect DB, start server
│   ├── app.ts                     # Express setup: middleware, routes, Swagger
│   ├── swagger.ts                 # OpenAPI / Swagger config
│   │
│   ├── routes/
│   │   ├── auth.ts                # Register, login, OTP, refresh, forgot/reset
│   │   ├── orders.ts              # Customer order CRUD, status, cancel, rate
│   │   ├── vendor.ts              # Vendor orders, station, inventory, earnings
│   │   ├── rider.ts               # Rider profile, availability, deliveries, earnings
│   │   ├── admin.ts               # Admin stats, users, stations, riders, settlement
│   │   ├── payments.ts            # Paystack initialize, verify, webhook
│   │   ├── stations.ts            # Public station list + admin CRUD
│   │   ├── fuelTypes.ts           # Fuel type catalogue
│   │   ├── address.ts             # Customer address book
│   │   ├── points.ts              # Loyalty points balance, history, redeem
│   │   ├── notifications.ts       # Notification centre
│   │   └── upload.ts              # Cloudinary image upload
│   │
│   ├── models/
│   │   ├── User.ts                # email, password, role, points, deviceTokens
│   │   ├── Order.ts               # Fuel delivery order (fuelCost, deliveryFee, riderId…)
│   │   ├── Station.ts             # Station (location, fuels[{fuel,price,available}], vendorId)
│   │   ├── FuelType.ts            # Fuel type catalogue entry
│   │   ├── Delivery.ts            # Rider dispatch record (one per candidate rider per order)
│   │   ├── RiderProfile.ts        # Rider vehicle, availability, location, earnings
│   │   ├── Earning.ts             # Rider/vendor earning per delivery
│   │   ├── Address.ts             # Customer delivery address
│   │   ├── Point.ts               # Loyalty point transaction
│   │   ├── Rating.ts              # Station rating (one per order)
│   │   ├── Notification.ts        # User notification
│   │   └── RefreshToken.ts        # JWT refresh token storage
│   │
│   ├── middleware/
│   │   ├── auth.ts                # requireAuth · requireCustomer · requireVendor · requireRider · requireAdmin
│   │   ├── validate.ts            # Zod schema validation
│   │   └── errorHandler.ts        # Global error handler
│   │
│   ├── validators/
│   │   ├── auth.validators.ts
│   │   ├── order.validators.ts    # createOrder · updateOrderStatus · rateOrder
│   │   └── address.validators.ts
│   │
│   ├── utils/
│   │   ├── jwt.ts                 # signAccessToken · signRefreshToken · verify*
│   │   ├── hash.ts                # hashPassword · comparePassword (bcrypt)
│   │   ├── email.ts               # sendOtpEmail (Resend)
│   │   ├── cloudinary.ts          # Cloudinary client config
│   │   ├── paystack.ts            # initializePayment · verifyPayment
│   │   ├── push.ts                # sendPushNotification (FCM)
│   │   ├── notify.ts              # notifyUser — DB notification + push
│   │   ├── haversine.ts           # haversineDistance · calcDeliveryFee
│   │   └── pagination.ts          # parsePagination query helper
│   │
│   ├── jobs/
│   │   ├── dispatchRiders.ts      # Broadcast dispatch to nearest available riders
│   │   ├── settlePoints.ts        # Settle pending loyalty points
│   │   ├── cleanupPoints.ts       # Expire old point records
│   │   └── index.ts               # Register all cron jobs
│   │
│   ├── scripts/
│   │   └── seed.ts                # DB seeder — 4 test accounts + fuel types + station
│   │
│   ├── config/
│   │   └── db.ts                  # Mongoose connection
│   │
│   └── types/
│       └── express.d.ts           # Augments Express Request with userId: string
│
├── dist/                          # Compiled JS output (git-ignored)
├── tsconfig.json
├── package.json
├── .env.example                   # Variable template (committed — no secrets)
└── .env                           # Local/production secrets (git-ignored)
```

---

## API Reference

Interactive docs: `http://localhost:5000/api-docs`

> All `/api/*` routes require `Authorization: Bearer <accessToken>` unless noted.

### Authentication — `/auth`

> Rate-limited: 10 requests per 15 minutes per IP.

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/auth/register` | None | Create account + send OTP email; accepts `role` field |
| `POST` | `/auth/verify-otp` | None | Verify email OTP; marks `isVerified: true` |
| `POST` | `/auth/resend-otp` | None | Resend OTP |
| `POST` | `/auth/login` | None | Returns `{ user, accessToken, refreshToken }` |
| `POST` | `/auth/forgot-password` | None | Send password-reset OTP |
| `POST` | `/auth/reset-password` | None | Verify OTP + set new password; revokes refresh tokens |
| `POST` | `/auth/refresh-token` | None | Rotate refresh token; returns new pair |
| `POST` | `/auth/logout` | None | Delete refresh token from DB |
| `GET`  | `/auth/me` | JWT | Get current user |
| `PUT`  | `/auth/me` | JWT | Update profile (displayName, phone, gender, profileImage) |
| `POST` | `/auth/device-token` | JWT | Register FCM device token |
| `DELETE` | `/auth/device-token` | JWT | Remove FCM device token |

### Customer Orders — `/api/orders`

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/orders` | Place order — calculates delivery fee, validates station fuel availability, notifies vendor |
| `GET`  | `/api/orders` | Paginated order list; filter by `status`, `startDate`, `endDate` |
| `GET`  | `/api/orders/:id` | Get single order (ownership checked) |
| `PATCH` | `/api/orders/:id/status` | Update status (admin/internal use) |
| `PATCH` | `/api/orders/:id/cancel` | Cancel pending order; reverses placement points |
| `POST` | `/api/orders/:id/rate` | Rate station 1–5 after delivery; awards points |

### Vendor — `/api/vendor`

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET`  | `/api/vendor/profile` | Get vendor user + station info |
| `GET`  | `/api/vendor/orders` | Paginated orders for this vendor; filter by `status` |
| `PATCH` | `/api/vendor/orders/:id/confirm` | Confirm pending order; triggers dispatch cron on next tick |
| `PATCH` | `/api/vendor/orders/:id/reject` | Reject pending or confirmed order |
| `PATCH` | `/api/vendor/station/fuels` | Update fuel price and/or availability |
| `PATCH` | `/api/vendor/station` | Update station name, hours, isActive toggle |
| `GET`  | `/api/vendor/earnings` | Paginated earnings + pending/settled aggregate |

### Rider — `/api/rider`

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/rider/setup` | Complete onboarding; creates RiderProfile |
| `GET`  | `/api/rider/profile` | Get rider profile |
| `PATCH` | `/api/rider/availability` | Toggle `isAvailable` |
| `PATCH` | `/api/rider/location` | Update `currentLocation` `{ lat, lng }` (polled every 30 s) |
| `GET`  | `/api/rider/active` | Get current in-progress delivery |
| `PATCH` | `/api/rider/deliveries/:id/accept` | Accept dispatch; cancel competing records; notify customer |
| `PATCH` | `/api/rider/deliveries/:id/pickup` | Confirm fuel pickup; order → `in-transit` |
| `PATCH` | `/api/rider/deliveries/:id/complete` | Complete delivery; credit rider + vendor earnings |
| `GET`  | `/api/rider/deliveries` | Paginated delivery history |
| `GET`  | `/api/rider/earnings` | Paginated earnings + pending/settled aggregate |

### Admin — `/api/admin`

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET`  | `/api/admin/stats` | Platform snapshot: users, orders, revenue, active riders |
| `GET`  | `/api/admin/users` | Paginated user list |
| `PATCH` | `/api/admin/users/:id/role` | Update user role |
| `GET`  | `/api/admin/stations` | All stations |
| `PATCH` | `/api/admin/stations/:id/verify` | Mark station verified |
| `PATCH` | `/api/admin/stations/:id/active` | Toggle station active state |
| `GET`  | `/api/admin/orders` | All orders with status filter |
| `GET`  | `/api/admin/riders` | All rider profiles |
| `PATCH` | `/api/admin/riders/:id/verify` | Mark rider verified |
| `PATCH` | `/api/admin/earnings/settle` | Manually trigger earnings settlement |

### Stations — `/api/stations`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET`  | `/api/stations` | None | List stations; params: `lat`, `lng`, `radius`, `state`, `lga`, `search` |
| `GET`  | `/api/stations/:id` | None | Get station (populates fuel types) |
| `POST` | `/api/stations` | Admin | Create station |
| `PUT`  | `/api/stations/:id` | Admin | Update station |
| `DELETE` | `/api/stations/:id` | Admin | Delete station |

### Other Routes

| Group | Prefix | Key Endpoints |
|-------|--------|---------------|
| Fuel Types | `/api/fuel-types` | `GET` list, `POST` create (admin) |
| Address Book | `/api/address-book` | CRUD + set default |
| Points | `/api/points` | balance, history, redeem |
| Notifications | `/api/notifications` | list, mark read, unread count, delete |
| Upload | `/api/upload/image` | Cloudinary image upload |
| Payments | `/api/payments` | initialize, verify, webhook |

---

## Data Models

### User
```ts
{
  email: string          // unique
  phone: string
  passwordHash: string
  displayName: string
  gender: "male" | "female"
  role: "customer" | "vendor" | "rider" | "admin"
  isOnboarded: boolean
  profileImage: string   // Cloudinary URL
  points: number         // settled loyalty balance
  deviceTokens: string[] // FCM tokens
  isVerified: boolean
  defaultAddress?: ObjectId
}
```

### Order
```ts
{
  user: ObjectId           // → User (customer)
  fuel: ObjectId           // → FuelType
  station: ObjectId        // → Station
  quantity: number
  unit: string
  fuelCost: number         // quantity × station pricePerUnit
  deliveryFee: number      // Haversine-calculated
  totalPrice: number       // fuelCost + deliveryFee (reduced by points redemption)
  status: "pending" | "confirmed" | "assigned" | "in-transit" | "delivered" | "cancelled"
  paymentStatus: "pending" | "paid" | "failed"
  paymentRef?: string
  deliveryAddress: ObjectId
  riderId?: ObjectId
  riderAssignedAt?: Date
  dispatchAttempt: number
  dispatchExpiresAt?: Date
  cylinderType?: string
  deliveryType?: "cylinder_swap" | "home_refill"
  cylinderImages?: string[]
}
```

### Delivery (one per candidate rider per order)
```ts
{
  order: ObjectId       // → Order
  rider: ObjectId       // → User (rider)
  station: ObjectId     // → Station
  status: "pending" | "accepted" | "picked_up" | "delivered" | "failed"
  riderEarnings: number  // pre-computed on dispatch
  platformEarnings: number
  pickupTime?: Date
  deliveryTime?: Date
}
```

### RiderProfile
```ts
{
  user: ObjectId        // → User (unique)
  vehicleType: "motorcycle" | "tricycle" | "van"
  vehiclePlate: string
  isAvailable: boolean
  isVerified: boolean
  currentLocation?: { lat: number; lng: number }
  rating: number
  totalDeliveries: number
  bankAccount?: { bankName; accountNumber; accountName; paystackRecipientCode? }
}
```

### Earning
```ts
{
  user: ObjectId       // → User (rider or vendor)
  role: "rider" | "vendor"
  order: ObjectId
  delivery: ObjectId
  amount: number
  type: "delivery_fee" | "fuel_sale"
  status: "pending" | "settled"
}
```

### Station
```ts
{
  name: string
  address: string
  state: string
  lga: string
  location: { lat: number; lng: number }
  fuels: Array<{ fuel: ObjectId; pricePerUnit: number; available: boolean }>
  rating: number
  image: string       // Cloudinary URL
  verified: boolean
  vendorId?: ObjectId
  isActive: boolean
  operatingHours?: { open: string; close: string }
}
```

---

## Authentication Flow

```
1. Register   POST /auth/register  { email, password, role }
              └── Creates user (isVerified: false)
              └── Sends 6-digit OTP (10-min expiry)
              └── Returns { accessToken, refreshToken, user }

2. Verify     POST /auth/verify-otp
              └── Checks OTP + expiry → isVerified: true

3. Login      POST /auth/login
              └── Verifies password + isVerified
              └── Returns new accessToken (15 min) + refreshToken (7 days)

4. Requests   Authorization: Bearer <accessToken>
              └── requireAuth verifies JWT → attaches req.userId

5. Refresh    POST /auth/refresh-token
              └── Deletes old token from DB (rotation)
              └── Returns new pair

6. Onboarding index.tsx checks user.isOnboarded
              └── false → role-specific onboarding wizard
              └── true  → role-based home tab
```

---

## Dispatch System

```
Cron: every 1 minute — dispatchRiders()

Step 1 — Handle timeouts:
  Find Delivery records where status=pending and dispatchExpiresAt < now
  If order.dispatchAttempt < RIDER_DISPATCH_MAX_ROUNDS → reset for re-broadcast
  Else → cancel order (no rider available)

Step 2 — Dispatch confirmed orders:
  Find orders where status=confirmed and dispatchAttempt=0 (or next round due)
  Query RiderProfile where isAvailable=true, isVerified=true within radius
  Sort by distance (Haversine from station)
  Create Delivery records for up to 3 nearest riders
  Pre-compute riderEarnings = deliveryFee × (1 - PLATFORM_DELIVERY_COMMISSION/100)
  Send 'dispatch' push notification to each candidate
  Set order.dispatchExpiresAt = now + RIDER_DISPATCH_TIMEOUT_SECONDS

Rider accepts: PATCH /api/rider/deliveries/:id/accept
  → order.status = "assigned"
  → Competing Delivery records deleted
  → Customer notified "Rider Assigned"
```

---

## Payment Flow

```
1. Place Order    POST /api/orders
                  └── Returns { _id, totalPrice, fuelCost, deliveryFee }

2. Init Payment   POST /api/payments/initialize  { orderId }
                  └── Calls Paystack API
                  └── Stores reference on order
                  └── Returns { authorizationUrl, reference }

3. User pays on Paystack hosted page (WebView)

4. Verify         POST /api/payments/verify  { reference }
                  └── Paystack API confirms status === "success"
                  └── order.paymentStatus = "paid", order.status = "confirmed"
                  └── Vendor notified "new_order"

5. Webhook        POST /api/payments/webhook
                  └── HMAC-SHA512 signature validated
                  └── Handles charge.success as fallback
                  └── Idempotent — skips if already paid
```

> **Note:** Paystack integration is currently a stub pending business account setup. The WebView screen exists; it will activate once `PAYSTACK_SECRET_KEY` is set to a live key.

---

## Middleware

| Middleware | Description |
|------------|-------------|
| `requireAuth` | Verifies Bearer JWT; attaches `req.userId`; returns 401 if missing/invalid |
| `requireCustomer` | Role check after requireAuth; returns 403 if role ≠ `"customer"` |
| `requireVendor` | Role check; returns 403 if role ≠ `"vendor"` |
| `requireRider` | Role check; returns 403 if role ≠ `"rider"` |
| `requireAdmin` | Role check; returns 403 if role ≠ `"admin"` |
| `validate(schema)` | Zod parse of `req.body`; returns 400 with `{ errors }` on failure |
| MongoDB sanitizer | Strips `$`-prefixed keys from body/query — prevents NoSQL injection |

Rate limits: auth `10 req/15 min`, API `100 req/min` per IP.

---

## Background Jobs

| Job | Schedule | Description |
|-----|----------|-------------|
| `dispatchRiders` | Every minute | Broadcast dispatch to nearest available riders; handle timeouts |
| `settlePoints` | Every 10 minutes | Credit settled loyalty points to user balances |
| `cleanupPoints` | Nightly | Remove expired point records |

---

## Setup & Running

### Development

```bash
cd server
npm install
cp .env.example .env   # fill in all required variables
npm run dev            # ts-node-dev with hot reload on :5000
```

### Seed test data

```bash
npm run seed
```

Creates 4 accounts (customer / vendor / rider / admin), fuel types, a test station, and a rider profile. All passwords: `Password@123`. Safe to re-run.

### Type Check

```bash
npx tsc --noEmit
```

### Production Build

```bash
npm run build   # tsc → dist/
npm start       # node dist/index.js
```

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | Yes | HTTP port (default: 5000) |
| `MONGO_URI` | Yes | MongoDB Atlas connection string |
| `JWT_SECRET` | Yes | Access token secret — `openssl rand -hex 32` |
| `JWT_REFRESH_SECRET` | Yes | Refresh token secret — must differ from JWT_SECRET |
| `CLOUDINARY_CLOUD_NAME` | Yes | Cloudinary cloud name |
| `CLOUDINARY_API_KEY` | Yes | Cloudinary API key |
| `CLOUDINARY_API_SECRET` | Yes | Cloudinary API secret |
| `FIREBASE_PROJECT_ID` | Yes | Firebase project ID |
| `FIREBASE_CLIENT_EMAIL` | Yes | Firebase service account email |
| `FIREBASE_PRIVATE_KEY` | Yes | Firebase private key (quoted, `\n` newlines) |
| `RESEND_API_KEY` | Yes | Resend API key |
| `PAYSTACK_SECRET_KEY` | Yes | `sk_test_*` dev / `sk_live_*` prod |
| `POINTS_ORDER_PLACED` | No | Points on order placement (default: 100) |
| `POINTS_ORDER_DELIVERED` | No | Points on delivery (default: 50) |
| `POINTS_RATE_STATION` | No | Points on rating (default: 50) |
| `DELIVERY_BASE_FEE` | No | Base delivery fee in kobo (default: 500) |
| `DELIVERY_PER_KM` | No | Additional fee per km in kobo (default: 100) |
| `RIDER_DISPATCH_RADIUS_KM` | No | Dispatch search radius (default: 10) |
| `RIDER_DISPATCH_TIMEOUT_SECONDS` | No | Per-round dispatch timeout (default: 180) |
| `RIDER_DISPATCH_MAX_ROUNDS` | No | Max broadcast rounds before cancel (default: 3) |
| `PLATFORM_FUEL_COMMISSION` | No | Vendor commission % deducted from fuel sale (default: 10) |
| `PLATFORM_DELIVERY_COMMISSION` | No | Rider commission % deducted from delivery fee (default: 5) |
| `PAYSTACK_SPLITS_ENABLED` | No | Enable Paystack Split Payments (default: false) |

---

## Known Limitations & TODO

- **Paystack integration** — WebView checkout is stubbed; activate with a live `PAYSTACK_SECRET_KEY`
- **Admin mobile screens** — Admin API routes exist; no mobile UI yet
- **Station geospatial** — current queries use bounding-box approximation; switch to MongoDB `$near` with a `2dsphere` index for accuracy
- **No API versioning** — prefix routes with `/v1/` before shipping a breaking v2 API
- **Structured logging** — Pino is installed but not wired in; `console.*` used throughout
- **No test coverage** — add Jest + Supertest integration tests
- **Settings not persisted** — notification toggles in the mobile app are UI-only; no backend endpoint

---

*Gaznger Backend v2.0 — Node.js · Express · MongoDB · TypeScript*
