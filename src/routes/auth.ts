import { Router } from "express";
import { db } from "../db/connection.js";
import { verifyPassword } from "../lib/auth.js";

export const authRouter = Router();

authRouter.post("/login", async (request, response) => {
  const { username, password } = request.body as { username?: string; password?: string };
  if (!username || !password) {
    response.status(400).json({ error: "Username and password are required." });
    return;
  }

  const user = await db("users").whereRaw("lower(username) = lower(?)", [username]).first();
  if (!user || !(await verifyPassword(user.password_hash, password))) {
    response.status(401).json({ error: "Invalid username or password." });
    return;
  }

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
