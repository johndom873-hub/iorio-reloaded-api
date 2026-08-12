import { Router } from "express";
import { db } from "../db/connection.js";
import { verifyPassword } from "../lib/auth.js";

export const authRouter = Router();

authRouter.post("/login", async (request, response) => {
  const { email, password } = request.body as { email?: string; password?: string };
  if (!email || !password) {
    response.status(400).json({ error: "Email and password are required." });
    return;
  }

  const user = await db("users").where({ email }).first();
  if (!user || !(await verifyPassword(user.password_hash, password))) {
    response.status(401).json({ error: "Invalid email or password." });
    return;
  }

  request.session.userId = user.id;
  response.json({ id: user.id, email: user.email, displayName: user.display_name });
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

  response.json({ id: user.id, email: user.email, displayName: user.display_name });
});
