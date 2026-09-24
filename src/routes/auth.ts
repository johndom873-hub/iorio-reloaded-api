import { Router } from "express";
import { db } from "../db/connection.js";
import { verifyPassword } from "../lib/auth.js";

export const authRouter = Router();

// Login throttle (approved 2026-09-24): 10 attempts per 15 minutes per client
// address, counted on failures only. In-memory per dyno — a decoration
// against casual brute force, not a distributed rate limiter.
const loginThrottleWindowMs = 15 * 60 * 1000;
const loginThrottleMaxFailures = 10;
const loginFailuresByAddress = new Map<string, number[]>();

function clientAddress(request: { ip?: string; headers: Record<string, unknown> }): string {
  const forwarded = request.headers["x-forwarded-for"];
  const first = Array.isArray(forwarded) ? forwarded[0] : typeof forwarded === "string" ? forwarded.split(",")[0] : undefined;
  return (first ?? request.ip ?? "unknown").trim();
}

function recentLoginFailures(address: string, now: number): number[] {
  const kept = (loginFailuresByAddress.get(address) ?? []).filter((at) => now - at < loginThrottleWindowMs);
  if (kept.length === 0) loginFailuresByAddress.delete(address);
  else loginFailuresByAddress.set(address, kept);
  return kept;
}

authRouter.post("/login", async (request, response) => {
  const { username, password } = request.body as { username?: string; password?: string };
  if (!username || !password) {
    response.status(400).json({ error: "Username and password are required." });
    return;
  }

  const address = clientAddress(request);
  const now = Date.now();
  if (recentLoginFailures(address, now).length >= loginThrottleMaxFailures) {
    response.status(429).json({ error: "Too many failed login attempts — try again in 15 minutes." });
    return;
  }

  const user = await db("users").whereRaw("lower(username) = lower(?)", [username]).first();
  if (!user || !(await verifyPassword(user.password_hash, password))) {
    loginFailuresByAddress.set(address, [...recentLoginFailures(address, now), now]);
    response.status(401).json({ error: "Invalid username or password." });
    return;
  }
  loginFailuresByAddress.delete(address);

  // A fresh session id on login (session fixation): whatever id the browser
  // carried before authenticating is never the authenticated one.
  await new Promise<void>((resolve, reject) => request.session.regenerate((error) => (error ? reject(error) : resolve())));
  request.session.userId = user.id;
  response.json({ id: user.id, username: user.username, displayName: user.display_name });
});

authRouter.post("/logout", (request, response) => {
  request.session.destroy((error) => {
    if (error) {
      response.status(500).json({ error: "Failed to log out." });
      return;
    }
    response.clearCookie("connect.sid");
    response.status(204).end();
  });
});

authRouter.get("/session", async (request, response) => {
  if (!request.session.userId) {
    response.status(401).json({ error: "Not logged in." });
    return;
  }

  const user = await db("users").where({ id: request.session.userId }).first();
  if (!user) {
    response.status(401).json({ error: "Not logged in." });
    return;
  }

  response.json({ id: user.id, username: user.username, displayName: user.display_name });
});
