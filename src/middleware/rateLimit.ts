import { NextFunction, Request, Response } from "express";
import { AUTH_RATE_LIMIT_MAX_REQUESTS, RATE_LIMIT_WINDOW_MS, USER_RATE_LIMIT_MAX_REQUESTS } from "../config";
import { toError } from "../utils/http";

type RateEntry = { count: number; windowStart: number };

const createRateLimit = (maxRequests: number, keyResolver: (req: Request) => string) => {
  const rateStore = new Map<string, RateEntry>();

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = keyResolver(req);
    const now = Date.now();
    const current = rateStore.get(key);
    
    console.log(`[RateLimit] key: ${key}, current count: ${current?.count ?? 0}, max: ${maxRequests}, store size: ${rateStore.size}`);

    if (!current || now - current.windowStart >= RATE_LIMIT_WINDOW_MS) {
      rateStore.set(key, { count: 1, windowStart: now });
      console.log(`[RateLimit] reset window for key: ${key}`);
    } else {
      current.count += 1;
      console.log(`[RateLimit] incremented key: ${key} to count: ${current.count}`);
      if (current.count > maxRequests) {
        const retryAfterSeconds = Math.max(1, Math.ceil((RATE_LIMIT_WINDOW_MS - (now - current.windowStart)) / 1000));
        const resetAt = Math.floor((current.windowStart + RATE_LIMIT_WINDOW_MS) / 1000);
        res.setHeader("Retry-After", String(retryAfterSeconds));
        res.setHeader("X-RateLimit-Limit", String(maxRequests));
        res.setHeader("X-RateLimit-Remaining", "0");
        res.setHeader("X-RateLimit-Reset", String(resetAt));
        console.log(`[RateLimit] ENFORCING 429 for key: ${key} (count: ${current.count})`);
        toError(res, 429, "Too Many Requests");
        return;
      }
    }

    if (rateStore.size > 10_000) {
      const cutoff = now - RATE_LIMIT_WINDOW_MS;
      for (const [storedKey, value] of rateStore.entries()) {
        if (value.windowStart < cutoff) {
          rateStore.delete(storedKey);
        }
      }
    }

    // Set standard rate limit headers for successful requests
    const entry = rateStore.get(key)!;
    const resetAt = Math.floor((entry.windowStart + RATE_LIMIT_WINDOW_MS) / 1000);
    const remaining = Math.max(0, maxRequests - entry.count);
    res.setHeader("X-RateLimit-Limit", String(maxRequests));
    res.setHeader("X-RateLimit-Remaining", String(remaining));
    res.setHeader("X-RateLimit-Reset", String(resetAt));
    console.log(`[RateLimit] allowing key: ${key}, remaining: ${remaining}`);
    next();
  };
};

const resolveIpKey = (req: Request): string => {
  // Trust proxy to get real IP
  const forwarded = req.header("x-forwarded-for");
  if (forwarded) {
    const ips = forwarded.split(",").map((ip) => ip.trim());
    const ip = ips[0] || "unknown";
    console.log(`[RateLimit] x-forwarded-for: ${forwarded} -> resolved to: ${ip}`);
    return ip;
  }
  const fallback = req.ip || req.socket.remoteAddress || "unknown";
  console.log(`[RateLimit] no x-forwarded-for, req.ip: ${req.ip}, socket: ${req.socket.remoteAddress} -> resolved to: ${fallback}`);
  return fallback;
};

const resolveUserKey = (req: Request): string => req.authUser?.id ?? resolveIpKey(req);

export const authRateLimit = createRateLimit(AUTH_RATE_LIMIT_MAX_REQUESTS, resolveIpKey);

export const userRateLimit = createRateLimit(USER_RATE_LIMIT_MAX_REQUESTS, resolveUserKey);
