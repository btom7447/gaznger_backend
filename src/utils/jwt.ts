import jwt from "jsonwebtoken";

const ACCESS_SECRET = process.env.JWT_SECRET!;
const ACCESS_SECRET_NEXT = process.env.JWT_SECRET_NEXT;
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET!;
const REFRESH_SECRET_NEXT = process.env.JWT_REFRESH_SECRET_NEXT;

// SECURITY (audit E.3): bind tokens to issuer + audience so a token
// minted by another Gaznger service (or a future federated identity)
// can't be replayed against the customer/rider/vendor API. `kid`
// preserves the rotation slot — when we cut over to JWT_SECRET_NEXT
// we'll bump JWT_KID and accept both during the overlap window.
const ISS = "gaznger-api";
const AUD = "gaznger-mobile";
const KID = process.env.JWT_KID ?? "k1";

export const signAccessToken = (payload: object) => {
  return jwt.sign(payload, ACCESS_SECRET, {
    expiresIn: "15m",
    issuer: ISS,
    audience: AUD,
    keyid: KID,
  });
};

export const signRefreshToken = (payload: object) => {
  return jwt.sign(payload, REFRESH_SECRET, {
    expiresIn: "7d",
    issuer: ISS,
    audience: AUD,
    keyid: KID,
  });
};

const tryVerify = (token: string, secrets: (string | undefined)[]) => {
  for (const s of secrets) {
    if (!s) continue;
    try {
      return jwt.verify(token, s, { issuer: ISS, audience: AUD });
    } catch {
      // try next secret in the rotation window
    }
  }
  return null;
};

export const verifyToken = (token: string) => {
  return tryVerify(token, [ACCESS_SECRET, ACCESS_SECRET_NEXT]);
};

export const verifyRefreshToken = (token: string): { id: string } | null => {
  const payload = tryVerify(token, [REFRESH_SECRET, REFRESH_SECRET_NEXT]);
  return payload ? (payload as { id: string }) : null;
};
