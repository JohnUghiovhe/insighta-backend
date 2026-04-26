import { Response } from "express";

export const toError = (res: Response, code: number, message: string): void => {
  res.status(code).json({ status: "error", message });
};
