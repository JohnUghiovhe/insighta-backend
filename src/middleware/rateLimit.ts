import { NextFunction, Request, Response } from "express";
import { RATE_LIMIT_MAX_REQUESTS, RATE_LIMIT_WINDOW_MS } from "../config";
import { toError } from "../utils/http";

const rateStore = new Map<string, { count: number; windowStart: number }>();

export const rateLimit = (req: Request, res: Response, next: NextFunction): void => {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const current = rateStore.get(ip);

  if (!current || now - current.windowStart >= RATE_LIMIT_WINDOW_MS) {
    rateStore.set(ip, { count: 1, windowStart: now });
  } else {
    current.count += 1;
    if (current.count > RATE_LIMIT_MAX_REQUESTS) {
      toError(res, 429, "Too many requests");
      return;
    }
  }

  if (rateStore.size > 10_000) {
    const cutoff = now - RATE_LIMIT_WINDOW_MS;
    for (const [key, value] of rateStore.entries()) {
      if (value.windowStart < cutoff) {
        rateStore.delete(key);
      }
    }
  }

  next();
};
