import { Router } from "express";
import { updateUserRole } from "../controllers/userController";
import { authorizeRoles } from "../middleware/auth";

export const userRoutes = Router();

userRoutes.patch("/:id/role", authorizeRoles("admin"), updateUserRole);