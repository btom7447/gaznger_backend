import { Request, Response, NextFunction } from "express";

export function errorHandler(
  err: any,
  _req: Request,
  res: Response,
  _next: NextFunction
) {
  console.error("[ERROR]", err);
  const status: number = err.status || err.statusCode || 500;
  const message: string = status === 500 ? "Internal server error" : (err.message || "Internal server error");
  const errors: string[] | undefined = err.errors;
  res.status(status).json({
    success: false,
    message,
    ...(errors ? { errors } : {}),
  });
}
