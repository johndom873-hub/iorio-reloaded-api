import express from "express";
import cors from "cors";
import { environment } from "./config/env.js";
import { sessionMiddleware } from "./middleware/session.js";
import { authRouter } from "./routes/auth.js";
import { healthRouter } from "./routes/health.js";

export const app = express();

app.use(
  cors({
    origin: environment.frontendOrigin,
    credentials: true,
  }),
);
app.use(express.json());
app.use(sessionMiddleware);

app.use(healthRouter);
app.use("/auth", authRouter);
