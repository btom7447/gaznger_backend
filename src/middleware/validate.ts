import { Request, Response, NextFunction } from "express";
import { ZodSchema, ZodError, ZodIssue } from "zod";

export function validate(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      schema.parse(req.body);
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        const errors = err.issues.map((issue: ZodIssue) => `${issue.path.join(".")}: ${issue.message}`);
        console.error("[validate] Body received:", JSON.stringify(req.body));
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
