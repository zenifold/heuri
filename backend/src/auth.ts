import type { NextFunction, Request, Response } from "express";
import { config } from "./config.js";

export function requireSharedSecret(req: Request, res: Response, next: NextFunction) {
  const provided = req.header("x-heuri-secret");
  if (!provided || provided !== config.sharedSecret) {
    res.status(401).json({ error: "Missing or invalid x-heuri-secret header" });
    return;
  }
  next();
}
