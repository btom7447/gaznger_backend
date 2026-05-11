/**
 * Recursive redactor for log payloads.
 *
 * SECURITY (audit A.5): Zod validation failures used to log the full
 * `req.body` — bodies for `/verify-otp`, `/login`, `/pin/set`,
 * `/pin/verify`, `/forgot-pin/reset`, `/signup`, `/auth/refresh-token`
 * carry plaintext OTPs, PINs, passwords, and refresh tokens. Same
 * goes for any future log line that hands raw request shape to
 * console.log. This redactor walks the object and replaces values for
 * any key matching a sensitive-name set (case-insensitive) with a
 * fixed sentinel.
 *
 * Use cases:
 *   - middleware/validate.ts on Zod failure body logs
 *   - any debug `console.log({ req.body })` that leaks
 *
 * Properties:
 *   - Deep walk; arrays handled.
 *   - Doesn't mutate the input.
 *   - Bounded depth (16) to avoid pathological cycles.
 *   - Returns a string-safe shape (JSON.stringify-able).
 */

const SENSITIVE_KEYS = new Set([
  "pin",
  "currentpin",
  "newpin",
  "password",
  "currentpassword",
  "newpassword",
  "otp",
  "code",
  "refreshtoken",
  "verificationtoken",
  "token",
  "accesstoken",
  "card",
  "cardnumber",
  "cvv",
  "cvc",
  "expiry",
  "expirymonth",
  "expiryyear",
  "secret",
  "apikey",
  "authorization",
  "authorizationcode",
]);

const REDACTED = "[REDACTED]";
const MAX_DEPTH = 16;

export function redactSensitive(input: unknown, depth = 0): unknown {
  if (depth >= MAX_DEPTH) return "[REDACTED:depth]";
  if (input == null) return input;
  if (Array.isArray(input)) {
    return input.map((v) => redactSensitive(v, depth + 1));
  }
  if (typeof input === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (SENSITIVE_KEYS.has(k.toLowerCase())) {
        out[k] = REDACTED;
        continue;
      }
      out[k] = redactSensitive(v, depth + 1);
    }
    return out;
  }
  // Primitives — leave as-is. A bare value like a JWT travelling on a
  // non-sensitive key is rare; we don't try to detect it here.
  return input;
}
