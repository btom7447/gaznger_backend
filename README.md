# Gaznger Backend API

> **Version 1.0** | Node.js/Express REST API for the Gaznger fuel delivery platform.

This is the server-side application that powers Gaznger. It provides authentication, order management, station discovery, loyalty points, push notifications, image uploads, and all other data operations consumed by the mobile app.

---

## Table of Contents

- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [API Reference](#api-reference)
- [Data Models](#data-models)
- [Authentication Flow](#authentication-flow)
- [Background Jobs](#background-jobs)
- [Setup & Running](#setup--running)
- [Environment Variables](#environment-variables)
- [What Needs Improvement](#what-needs-improvement)
- [What's Left to Complete](#whats-left-to-complete)

---

## Tech Stack

| Concern | Library / Tool | Version |
|---------|---------------|---------|
| Runtime | Node.js | 18+ |
| Language | TypeScript | 5.x |
| Framework | Express | 5.2.1 |
| Database | MongoDB (Atlas) · Mongoose | 9.1.1 |
| Authentication | JSON Web Tokens (jsonwebtoken) | 9.0.3 |
| Password Hashing | bcrypt | 6.0.0 |
| File Upload | Multer | 2.0.2 |
| Image Storage | Cloudinary | 2.8.0 |
| Push Notifications | Firebase Admin SDK (FCM) | 13.6.0 |
| Email | Nodemailer (Gmail SMTP) | 7.0.12 |
| Background Jobs | node-cron | 4.2.1 |
| API Documentation | Swagger UI Express + swagger-jsdoc | - |
| CORS | cors | 2.8.5 |
| Dev Server | ts-node-dev | - |

---

## Project Structure

```
server/
├── src/
│   ├── index.ts               # Entry point: loads env, connects DB, starts server
│   ├── app.ts                 # Express app setup: middleware, routes, Swagger, cron
│   ├── swagger.ts             # OpenAPI/Swagger configuration
│   │
│   ├── routes/                # API route handlers
│   │   ├── auth.ts            # Registration, login, OTP, token refresh
│   │   ├── orders.ts          # Order CRUD and status management
│   │   ├── stations.ts        # Station listing and filtering
│   │   ├── fuelTypes.ts       # Fuel type catalog
│   │   ├── address.ts         # Address book CRUD
│   │   ├── points.ts          # Loyalty points history and balance
│   │   ├── notifications.ts   # User notification management
│   │   ├── upload.ts          # Cloudinary image upload endpoint
│   │   └── tempPoints.ts      # Temporary/pending points handling
│   │
│   ├── models/                # Mongoose schemas and models
│   │   ├── User.ts            # User profile and account data
│   │   ├── Order.ts           # Fuel delivery orders
│   │   ├── Station.ts         # Gas station data
│   │   ├── FuelType.ts        # Fuel type catalog entries
│   │   ├── Address.ts         # User delivery addresses
│   │   ├── Point.ts           # Loyalty point transactions
│   │   ├── Rating.ts          # Station ratings
│   │   ├── Notification.ts    # User notifications
│   │   └── RefreshToken.ts    # JWT refresh token storage
│   │
│   ├── middleware/
│   │   └── auth.ts            # JWT verification middleware (protects routes)
│   │
│   ├── utils/
│   │   ├── hash.ts            # bcrypt password hashing helpers
│   │   ├── jwt.ts             # JWT sign/verify helpers
│   │   ├── email.ts           # Nodemailer email sending
│   │   ├── cloudinary.ts      # Cloudinary upload helper
│   │   └── push.ts            # Firebase FCM push notification helper
│   │
│   ├── jobs/
│   │   ├── settlePoints.ts    # Cron job: settle pending loyalty points
│   │   └── index.ts           # Job scheduler / registration
│   │
│   └── config/
│       └── db.ts              # MongoDB connection setup
│
├── dist/                      # Compiled JavaScript output (git-ignored)
├── tsconfig.json              # TypeScript configuration
├── package.json
└── .env                       # Environment variables (never commit)
```

---

## API Reference

Swagger documentation is available at `/api-docs` when the server is running.

### Authentication — `/auth`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/auth/register` | None | Register a new user account |
| `POST` | `/auth/login` | None | Login and receive access + refresh tokens |
| `POST` | `/auth/verify-otp` | None | Verify email OTP code |
| `POST` | `/auth/resend-otp` | None | Resend OTP to email |
| `POST` | `/auth/reset-password` | None | Reset password using OTP |
| `POST` | `/auth/refresh` | None | Exchange refresh token for a new access token |
| `GET` | `/auth/me` | JWT | Get the current authenticated user's profile |
| `PUT` | `/auth/me` | JWT | Update user profile (name, phone, gender, image) |

### Fuel Types — `/api/fuel-types`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/api/fuel-types` | JWT | Get all available fuel types |
| `POST` | `/api/fuel-types` | JWT | Create a new fuel type entry (admin) |

### Stations — `/api/stations`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/api/stations` | JWT | List stations; supports `?state=` and `?lga=` query filters |
| `GET` | `/api/stations/:id` | JWT | Get a single station by ID |
| `POST` | `/api/stations/:id/rate` | JWT | Submit a rating for a station |

### Orders — `/api/orders`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/api/orders` | JWT | Get all orders for the authenticated user |
| `POST` | `/api/orders` | JWT | Place a new fuel delivery order |
| `GET` | `/api/orders/:id` | JWT | Get a specific order by ID |
| `PUT` | `/api/orders/:id/status` | JWT | Update order status (driver/admin) |

### Address Book — `/api/address-book`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/api/address-book` | JWT | List all saved addresses for the user |
| `POST` | `/api/address-book` | JWT | Add a new address |
| `PUT` | `/api/address-book/:id` | JWT | Update an existing address |
| `DELETE` | `/api/address-book/:id` | JWT | Delete an address |

### Points — `/api/points`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/api/points` | JWT | Get loyalty points balance and transaction history |

### Notifications — `/api/notifications`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/api/notifications` | JWT | Get all notifications for the user |
| `POST` | `/api/notifications/read/:id` | JWT | Mark a notification as read |

### Image Upload — `/api/upload`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/api/upload` | JWT | Upload an image file; returns Cloudinary URL |

---

## Data Models

### User
```
{
  email: String (unique),
  phone: String,
  password: String (hashed),
  firstName: String,
  lastName: String,
  gender: String,
  profileImage: String (Cloudinary URL),
  addressBook: [ObjectId -> Address],
  points: Number,
  deviceTokens: [String] (FCM tokens),
  isVerified: Boolean,
  otp: String,
  otpExpiry: Date
}
```

### Order
```
{
  user: ObjectId -> User,
  fuelType: ObjectId -> FuelType,
  station: ObjectId -> Station,
  cylinderType: String,
  quantity: Number,
  price: Number,
  status: Enum [pending, confirmed, in_transit, delivered, cancelled],
  deliveryAddress: String,
  deliveryType: Enum [home, pickup],
  cylinderImage: String (Cloudinary URL),
  createdAt: Date
}
```

### Station
```
{
  name: String,
  address: String,
  location: { type: "Point", coordinates: [lng, lat] },
  fuelPrices: [{ fuelType: String, price: Number }],
  rating: Number,
  totalRatings: Number,
  image: String (Cloudinary URL),
  state: String,
  lga: String
}
```

### FuelType
```
{
  name: String,
  description: String,
  icon: String,
  unit: String (litres / kg / etc.)
}
```

### Point
```
{
  user: ObjectId -> User,
  amount: Number,
  event: Enum [order_placed, order_delivered, station_rated],
  status: Enum [pending, settled],
  orderId: ObjectId -> Order,
  createdAt: Date
}
```

### Notification
```
{
  user: ObjectId -> User,
  title: String,
  body: String,
  isRead: Boolean,
  createdAt: Date
}
```

---

## Authentication Flow

Gaznger uses a **JWT access token + refresh token** pattern with email OTP verification:

```
1. Register (POST /auth/register)
   └── Creates user, sends OTP email, returns { message }

2. Verify OTP (POST /auth/verify-otp)
   └── Marks user as verified

3. Login (POST /auth/login)
   └── Returns { accessToken, refreshToken, user }
       └── accessToken: short-lived (e.g., 15 min)
       └── refreshToken: long-lived (e.g., 30 days), stored in DB

4. Authenticated Requests
   └── Include: Authorization: Bearer <accessToken>
   └── Middleware verifies token and attaches user to req.user

5. Token Refresh (POST /auth/refresh)
   └── Accepts { refreshToken }
   └── Validates against DB, issues new accessToken

6. Logout
   └── Client discards tokens; refresh token can be revoked in DB
```

---

## Background Jobs

### `settlePoints` (node-cron)

Scheduled to run periodically (see `jobs/settlePoints.ts`).

- Queries all `Point` documents with `status: "pending"`
- Updates matching points to `status: "settled"`
- Credits the settled points to the user's `points` balance on the `User` document

This delayed settlement pattern allows for an order cancellation window where points can be revoked before they are confirmed.

**Points Configuration (via `.env`):**
| Event | Points Awarded |
|-------|---------------|
| Order placed | 100 pts |
| Order delivered | 50 pts |
| Station rated | 50 pts |

---

## Setup & Running

### Prerequisites

- Node.js 18+
- MongoDB (local instance or Atlas cluster)
- A Firebase project with a service account (for push notifications)
- A Cloudinary account (for image uploads)
- A Gmail account with an App Password (for SMTP email)

### Install & Run (Development)

```bash
cd server
npm install
cp .env.example .env   # fill in all required variables
npm run dev
```

The server starts on `http://localhost:5000` with hot-reload via `ts-node-dev`.

### Build & Run (Production)

```bash
npm run build    # compiles TypeScript to dist/
npm start        # runs the compiled dist/index.js
```

### API Documentation

Navigate to `http://localhost:5000/api-docs` in your browser to view the interactive Swagger UI.

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | Yes | Server port (default: 5000) |
| `MONGO_URI` | Yes | MongoDB Atlas connection string |
| `JWT_SECRET` | Yes | Secret for signing JWT access tokens — **use a long random string in production** |
| `JWT_REFRESH_SECRET` | Yes | Separate secret for refresh tokens |
| `CLOUDINARY_CLOUD_NAME` | Yes | Cloudinary cloud name |
| `CLOUDINARY_API_KEY` | Yes | Cloudinary API key |
| `CLOUDINARY_API_SECRET` | Yes | Cloudinary API secret |
| `GOOGLE_MAPS_API_KEY` | No | Google Maps API key (for geocoding) |
| `FIREBASE_PROJECT_ID` | Yes | Firebase project ID |
| `FIREBASE_PRIVATE_KEY` | Yes | Firebase service account private key (include `\n` newlines) |
| `FIREBASE_CLIENT_EMAIL` | Yes | Firebase service account email |
| `EMAIL_USER` | Yes | Gmail address used to send OTP and transactional emails |
| `EMAIL_PASS` | Yes | Gmail App Password (not your regular Gmail password) |
| `POINTS_ORDER_PLACED` | No | Points awarded when order is placed (default: 100) |
| `POINTS_ORDER_DELIVERED` | No | Points awarded on delivery (default: 50) |
| `POINTS_STATION_RATED` | No | Points awarded for rating a station (default: 50) |

---

## What Needs Improvement

### Security (Critical — Fix Before Production)

- **Rotate the JWT secret** — the current secret is `supersecretkey`; replace with a cryptographically random 256-bit string
- **Restrict CORS origin** — `app.ts` currently sets `origin: "*"`; restrict to your frontend domain(s)
- **Add rate limiting** — install `express-rate-limit` on `/auth` endpoints to prevent brute-force and OTP abuse
- **Add HTTP security headers** — integrate `helmet.js` as the first middleware
- **Input validation** — add server-side schema validation (Zod or Joi) on all `req.body` inputs; never trust client data
- **Sanitize inputs** — add `express-mongo-sanitize` to prevent NoSQL injection via query operator injection
- **Audit all exposed endpoints** — some routes may be missing the `auth` middleware check

### Code Quality

- **No test coverage** — zero automated tests; add Jest + Supertest for route integration tests and unit tests for utilities
- **Inconsistent error responses** — different routes return errors in different shapes; standardize to `{ success: false, message: string, errors?: [] }`
- **Replace `console.log` with structured logging** — use Winston or Pino with log levels and JSON output for production observability
- **TypeScript strictness** — a few places cast to `any`; define proper types for all request/response payloads
- **Duplicate logic** — OTP generation and email sending are repeated in multiple route files; extract to shared utility functions

### Architecture

- **No role-based access control (RBAC)** — all authenticated users have the same permissions; add `role: "customer" | "driver" | "admin"` to the User model and enforce it in middleware
- **No API versioning** — prefix routes with `/v1/` to allow non-breaking future changes
- **No request logging middleware** — add `morgan` for HTTP access logs in development and production
- **No database indexing** — add indexes on:
  - `Station.location` (2dsphere index for geospatial queries)
  - `Station.state` + `Station.lga` (compound index for filter queries)
  - `Order.user` + `Order.status` (for order history queries)
  - `Point.user` + `Point.status` (for points settlement job)

### Performance

- **No caching** — fuel types and station lists are queried from MongoDB on every request; cache with Redis or an in-memory LRU cache
- **No pagination** — station and order list endpoints return all documents; add cursor or offset-based pagination

---

## What's Left to Complete

### Phase 1 — Critical for Launch

| Feature | Description |
|---------|-------------|
| **Payment Integration** | Webhook endpoints for Paystack or Flutterwave to confirm payment and update order status |
| **Order Assignment** | Logic to assign a confirmed order to an available driver (manual or automatic) |
| **Driver Endpoints** | API routes for a driver to: view assigned orders, update status to `in_transit` / `delivered` |
| **Driver Authentication** | Separate driver registration or invite flow with `role: "driver"` |
| **Real-time Updates** | Integrate Socket.io or Server-Sent Events to push order status changes to the mobile app live |
| **SMS OTP** | Integrate Termii or Twilio to send OTP via SMS as an alternative to email |

### Phase 2 — Enhanced Platform

| Feature | Description |
|---------|-------------|
| **Admin Endpoints** | CRUD for stations, fuel types, user management, and order oversight |
| **Station Inventory** | Track available fuel quantities per station; flag stations as out-of-stock |
| **Geospatial Queries** | Use MongoDB `$near` operator to return stations sorted by distance from user coordinates |
| **Order Pricing Engine** | Calculate total price server-side based on fuel type, quantity, and delivery distance |
| **Ratings Aggregation** | Recalculate station average rating when a new rating is submitted |
| **Email Templates** | Replace plain-text OTP emails with styled HTML templates (using Handlebars or MJML) |

### Phase 3 — Production & Scale

| Feature | Description |
|---------|-------------|
| **Docker Containerization** | Dockerfile + docker-compose for portable, consistent deployments |
| **CI/CD Pipeline** | GitHub Actions workflow: lint → test → build → deploy on push to main |
| **Environment-specific Config** | Separate `.env.development`, `.env.staging`, `.env.production` configurations |
| **Database Migrations** | Scripts to safely apply schema changes to a live MongoDB database |
| **Analytics Endpoints** | Aggregate endpoints for revenue, order volume, top stations, user retention |
| **API Rate Limiting Dashboard** | Monitor and configure rate limits per endpoint or per user |
| **Monitoring & Alerts** | Integrate Datadog, New Relic, or self-hosted Prometheus/Grafana |

---

*Gaznger Backend v1.0 — Node.js · Express · MongoDB · TypeScript*
