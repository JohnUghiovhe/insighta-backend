import { describe, expect, it, vi } from "vitest";
import { requireApiVersion } from "./middleware/apiVersion";
import { authorizeRoles } from "./middleware/auth";
import { authRateLimit, userRateLimit } from "./middleware/rateLimit";
import type { Request, Response } from "express";

vi.mock("./db", () => ({
  pool: {
    query: vi.fn()
  }
}));

describe("requireApiVersion", () => {
  it("calls next when version header is 1", () => {
    const next = vi.fn();
    const res = {
      setHeader: vi.fn(),
      status: vi.fn().mockReturnThis(),
      json: vi.fn()
    } as unknown as Response;
    const req = {
      header: vi.fn().mockReturnValue("1")
    } as unknown as Request;

    requireApiVersion(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("returns 400 when version header is missing", () => {
    const next = vi.fn();
    const setHeader = vi.fn();
    const status = vi.fn().mockReturnThis();
    const json = vi.fn();
    const res = { setHeader, status, json } as unknown as Response;
    const req = {
      header: vi.fn().mockReturnValue(undefined)
    } as unknown as Request;

    requireApiVersion(req, res, next);
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({ status: "error", message: "API version header required: X-API-Version: 1" });
    expect(next).not.toHaveBeenCalled();
  });
});

describe("authorizeRoles", () => {
  it("allows requests when role is in allowed list", () => {
    const middleware = authorizeRoles("admin", "analyst");
    const next = vi.fn();
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn()
    } as unknown as Response;
    const req = {
      authUser: { role: "admin" }
    } as unknown as Request;

    middleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("returns 403 when role is not allowed", () => {
    const middleware = authorizeRoles("admin");
    const next = vi.fn();
    const status = vi.fn().mockReturnThis();
    const json = vi.fn();
    const res = { status, json } as unknown as Response;
    const req = {
      authUser: { role: "analyst" }
    } as unknown as Request;

    middleware(req, res, next);
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith({ status: "error", message: "Forbidden" });
    expect(next).not.toHaveBeenCalled();
  });
});

describe("rate limits", () => {
  it("returns 429 on the 11th auth request from the same IP", () => {
    const next = vi.fn();
    const setHeader = vi.fn();
    const status = vi.fn().mockReturnThis();
    const json = vi.fn();
    const req = {
      header: vi.fn().mockImplementation((name: string) => (name.toLowerCase() === "x-forwarded-for" ? "203.0.113.10" : undefined)),
      ip: "203.0.113.10",
      socket: { remoteAddress: "203.0.113.10" }
    } as unknown as Request;
    const res = { setHeader, status, json } as unknown as Response;

    for (let attempt = 0; attempt < 10; attempt += 1) {
      authRateLimit(req, res, next);
    }

    expect(next).toHaveBeenCalledTimes(10);

    authRateLimit(req, res, next);

    expect(status).toHaveBeenCalledWith(429);
    expect(json).toHaveBeenCalledWith({ status: "error", message: "Too Many Requests" });
  });

  it("returns 429 on the 61st authenticated user request", () => {
    const next = vi.fn();
    const setHeader = vi.fn();
    const status = vi.fn().mockReturnThis();
    const json = vi.fn();
    const req = {
      authUser: { id: "user-rate-limit-test" },
      ip: "203.0.113.11",
      socket: { remoteAddress: "203.0.113.11" }
    } as unknown as Request;
    const res = { setHeader, status, json } as unknown as Response;

    for (let attempt = 0; attempt < 60; attempt += 1) {
      userRateLimit(req, res, next);
    }

    expect(next).toHaveBeenCalledTimes(60);

    userRateLimit(req, res, next);

    expect(status).toHaveBeenCalledWith(429);
    expect(json).toHaveBeenCalledWith({ status: "error", message: "Too Many Requests" });
  });
});
