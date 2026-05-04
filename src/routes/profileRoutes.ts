import { Router } from "express";
import { authorizeRoles } from "../middleware/auth";
import { createProfileHandlers } from "../controllers/profileController";

const handlers = createProfileHandlers();

export const profileRoutes = Router();

profileRoutes.get("/search", authorizeRoles("admin", "analyst"), handlers.searchProfiles);
profileRoutes.get("/export", authorizeRoles("admin", "analyst"), handlers.exportProfiles);
profileRoutes.post("/upload", authorizeRoles("admin"), handlers.uploadProfiles);
profileRoutes.get("/:id", authorizeRoles("admin", "analyst"), handlers.getProfile);
profileRoutes.get("/", authorizeRoles("admin", "analyst"), handlers.listProfiles);
profileRoutes.post("/", authorizeRoles("admin"), handlers.createProfile);
profileRoutes.delete("/:id", authorizeRoles("admin"), handlers.deleteProfile);
