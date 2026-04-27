import { NextFunction, Request, Response } from "express";

export const requestLogger = (req: Request, res: Response, next: NextFunction): void => {
  const startedAt = Date.now();
  res.on("finish", () => {
    const durationMs = Date.now() - startedAt;
    console.info(
      JSON.stringify({
        method: req.method,
        endpoint: req.originalUrl,
        statusCode: res.statusCode,
        responseTimeMs: durationMs,
        user_id: req.authUser?.id ?? null,
        ip: req.ip || req.socket.remoteAddress || "unknown"
      })
    );
  });
  next();
};
