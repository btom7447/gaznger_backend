import { Request, Response, NextFunction } from "express";
import { ZodSchema, ZodError, ZodIssue } from "zod";
import { redactSensitive } from "../utils/redact";

export function validate(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      // SEC-P2 (audit A1): use the Zod-parsed result so coercion +
      // defaults reach the route handler. Previously the parsed value
      // was discarded and raw req.body flowed into Mongoose, leaving
      // strict-mode as the only line of defence against unknown keys
      // (e.g. address.ts spreads req.body into Address.create).
      req.body = schema.parse(req.body);
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        const errors = err.issues.map((issue: ZodIssue) => `${issue.path.join(".")}: ${issue.message}`);
        // SECURITY (audit A.5): redact PIN/OTP/password/refreshToken/
        // card fields before logging. Without this, a Zod failure on
        // `/verify-otp` or `/pin/verify` dumps plaintext credentials
        // into stdout (and any log shipper).
        console.error(
          "[validate] Body received:",
          JSON.stringify(redactSensitive(req.body))
        );
        console.error("[validate] Errors:", errors);
        return res.status(400).json({
          success: false,
          message: "Validation failed",
          errors,
        });
      }
      next(err);
    }
  };
}
