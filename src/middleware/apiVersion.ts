import { NextFunction, Request, Response } from "express";
import { toError } from "../utils/http";

export const requireApiVersion = (req: Request, res: Response, next: NextFunction): void => {
  const version = req.header("X-API-Version");
  if (version !== "1") {
    toError(res, 400, "API version header required");
    return;
  }
  next();
};
