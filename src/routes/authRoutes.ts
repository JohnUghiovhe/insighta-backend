import { Router } from "express";
import { githubCallback, githubCliExchange, githubLogin, githubLoginInit, logout, refreshToken } from "../controllers/authController";

export const authRoutes = Router();

authRoutes.get("/github", githubLogin);
authRoutes.get("/github/init", githubLoginInit);
authRoutes.get("/github/callback", githubCallback);
authRoutes.post("/github/exchange", githubCliExchange);
authRoutes.post("/refresh", refreshToken);
authRoutes.post("/logout", logout);
