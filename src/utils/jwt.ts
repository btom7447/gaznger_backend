import jwt from "jsonwebtoken";

const ACCESS_SECRET = process.env.JWT_SECRET || "supersecret";
const REFRESH_SECRET = process.env.JWT_SECRET || "supersecret"; // can use separate secret if desired

export const signAccessToken = (payload: object) => {
  return jwt.sign(payload, ACCESS_SECRET, { expiresIn: "15m" });
};

export const signRefreshToken = (payload: object) => {
  return jwt.sign(payload, REFRESH_SECRET, { expiresIn: "7d" });
};

export const verifyToken = (token: string) => {
  try {
    return jwt.verify(token, ACCESS_SECRET);
  } catch {
    return null;
  }
};
