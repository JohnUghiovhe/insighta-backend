import express from "express";
import { authenticateAccessToken } from "./middleware/auth";
import { authRateLimit, userRateLimit } from "./middleware/rateLimit";
import { requestLogger } from "./middleware/requestLogger";
import { authRoutes } from "./routes/authRoutes";
import { profileRoutes } from "./routes/profileRoutes";
import { userRoutes } from "./routes/userRoutes";

export const createApp = () => {
  const app = express();

  app.use(express.json());
  app.use(requestLogger);
  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-API-Version");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
    if (req.method === "OPTIONS") {
      res.status(204).send();
      return;
    }
    next();
  });

  app.use("/auth", authRateLimit, authRoutes);

  app.use("/api", authenticateAccessToken);
  app.use(userRateLimit);

  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.use("/api/profiles", profileRoutes);
  app.use("/api/users", userRoutes);

  return app;
};
