import { Router } from "express";
import { db } from "../db/connection.js";

export const healthRouter = Router();

// Confirms both the API process and its database connection are alive —
// not one of the modular IBKR-dependent health checks (those come later),
// just the baseline "is the API up at all" signal.
healthRouter.get("/health", async (_request, response) => {
  try {
    await db.raw("select 1");
    response.json({ status: "ok" });
  } catch (error) {
    response.status(503).json({ status: "error", message: (error as Error).message });
  }
});
