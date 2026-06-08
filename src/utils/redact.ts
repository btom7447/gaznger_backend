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
  "authorization_code",
  // SEC-P1 (audit run 5): the original allowlist covered explicitly
  // sensitive keys but missed PII that ends up in request bodies +
  // log lines. A log dump of failed-login attempts ended up being
  // a "registered phone list correlated with login activity" — a
  // classic PII exposure. Adding phone/email here closes that vector
  // wherever redactSensitive is called.
  "phone",
  "phonenumber",
  "email",
  "emailaddress",
  // PCI scope creep — saved-card fingerprint shouldn't appear in logs.
  "signature",
  // Push targets — log leak of FCM tokens enables phishing pushes.
  "devicetokens",
  "devicetoken",
  "fcmtoken",
  "expopushtoken",
]);

/**
 * Mask a phone number for log/error lines that genuinely need a
 * caller identity but shouldn't expose the whole number. Returns
 * "+234*****1234" style — last 4 digits visible, everything else
 * obscured. Empty input → "[no-phone]".
 */
export function maskPhone(raw: string | null | undefined): string {
  if (!raw) return "[no-phone]";
  const digits = raw.replace(/[^\d+]/g, "");
  if (digits.length <= 4) return "*****";
  return `${digits.slice(0, 4)}*****${digits.slice(-4)}`;
}

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
