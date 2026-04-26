import { Router } from "express";
import { githubCallback, githubLogin, logout, refreshToken } from "../controllers/authController";

export const authRoutes = Router();

authRoutes.get("/github", githubLogin);
authRoutes.get("/github/callback", githubCallback);
authRoutes.post("/refresh", refreshToken);
authRoutes.post("/logout", logout);
