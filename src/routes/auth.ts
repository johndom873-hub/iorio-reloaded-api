import { Router } from "express";
import { db } from "../db/connection.js";
import { readPasskeyLoginMode } from "../config/passkeyLoginMode.js";
import { verifyPassword } from "../lib/auth.js";
import { clearLoginFailures, clientAddress, isLoginThrottled, recordLoginFailure } from "../lib/loginFailureThrottle.js";
import { userHasUsedPasskey } from "../lib/passkeys.js";
import { isAuthenticatedSession, regenerateSession } from "../lib/sessionAuthentication.js";
import { passkeyAuthRouter } from "./authPasskeys.js";

export const authRouter = Router();
authRouter.use("/passkey", passkeyAuthRouter);

const pendingEnrollmentLifetimeMs = 10 * 60 * 1000;

// Public: the login page asks which sign-in it should offer before anyone is signed in.
authRouter.get("/config", (_request, response) => {
  response.json({ passkeyLoginRequired: readPasskeyLoginMode() === "required" });
});

authRouter.post("/login", async (request, response) => {
  const { username, password } = request.body as { username?: string; password?: string };
  if (!username || !password) {
    response.status(400).json({ error: "Username and password are required." });
    return;
  }

  const address = clientAddress(request);
  const now = Date.now();
  if (isLoginThrottled(address, now)) {
    response.status(429).json({ error: "Too many failed login attempts — try again in 15 minutes." });
    return;
  }

  const user = await db("users").whereRaw("lower(username) = lower(?)", [username]).first();
  if (!user || !(await verifyPassword(user.password_hash, password))) {
    recordLoginFailure(address, now);
    response.status(401).json({ error: "Invalid username or password." });
    return;
  }

  const authenticatedUser = { id: user.id, username: user.username, displayName: user.display_name };

  if (readPasskeyLoginMode() === "off") {
    clearLoginFailures(address);
    await regenerateSession(request);
    request.session.userId = user.id;
    request.session.authMethod = "password";
    response.json(authenticatedUser);
    return;
  }

  // Passkeys required. A password alone never signs anyone in; it either opens enrolment of a first passkey or is refused.
  if (user.is_service_account) {
    // Genosuke signs in over the dyno's own loopback. The Heroku router always adds X-Forwarded-For, so a request that
    // carries it came from the internet and may not use a service account's password.
    if (request.headers["x-forwarded-for"] !== undefined) {
      recordLoginFailure(address, now);
      response.status(401).json({ error: "Invalid username or password." });
      return;
    }
    clearLoginFailures(address);
    await regenerateSession(request);
    request.session.userId = user.id;
    request.session.authMethod = "service_password";
    response.json(authenticatedUser);
    return;
  }

  if (await userHasUsedPasskey(user.id)) {
    response.status(403).json({ error: "This account signs in with a passkey. Use the Sign in with passkey button." });
    return;
  }
  clearLoginFailures(address);
  await regenerateSession(request);
  request.session.pendingPasskeyEnrollment = { userId: user.id, expiresAt: now + pendingEnrollmentLifetimeMs };
  response.json({ status: "passkey_enrollment_required" });
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
  if (!isAuthenticatedSession(request.session)) {
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
