import { describe, expect, it, vi } from "vitest";
import { requireApiVersion } from "./middleware/apiVersion";
import { authorizeRoles } from "./middleware/auth";
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
