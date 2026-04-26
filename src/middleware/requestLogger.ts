import { NextFunction, Request, Response } from "express";

export const requestLogger = (req: Request, res: Response, next: NextFunction): void => {
  const startedAt = Date.now();
  res.on("finish", () => {
    const durationMs = Date.now() - startedAt;
    console.info(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        duration_ms: durationMs,
        user_id: req.authUser?.id ?? null,
        ip: req.ip || req.socket.remoteAddress || "unknown"
      })
    );
  });
  next();
};
