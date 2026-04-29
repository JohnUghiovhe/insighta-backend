import { Router } from "express";
import { getMe, updateUserRole } from "../controllers/userController";
import { authorizeRoles } from "../middleware/auth";

export const userRoutes = Router();

userRoutes.get("/me", getMe);
userRoutes.patch("/:id/role", authorizeRoles("admin"), updateUserRole);