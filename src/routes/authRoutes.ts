import { Router } from "express";
import { githubCallback, githubCliExchange, githubLogin, githubLoginInit, logout, me, refreshToken } from "../controllers/authController";
import { authenticateAccessToken } from "../middleware/auth";

export const authRoutes = Router();

authRoutes.get("/github", githubLogin);
authRoutes.get("/github/init", githubLoginInit);
authRoutes.get("/github/callback", githubCallback);
authRoutes.post("/github/exchange", githubCliExchange);
authRoutes.get("/me", authenticateAccessToken, me);
authRoutes.post("/refresh", refreshToken);
authRoutes.post("/logout", logout);
