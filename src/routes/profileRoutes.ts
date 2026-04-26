import { Router } from "express";
import { authorizeRoles } from "../middleware/auth";
import { requireApiVersion } from "../middleware/apiVersion";
import { createProfileHandlers } from "../controllers/profileController";

const handlers = createProfileHandlers();

export const profileRoutes = Router();

profileRoutes.use(requireApiVersion);
profileRoutes.get("/search", authorizeRoles("admin", "analyst"), handlers.searchProfiles);
profileRoutes.get("/export", authorizeRoles("admin", "analyst"), handlers.exportProfiles);
profileRoutes.get("/:id", authorizeRoles("admin", "analyst"), handlers.getProfile);
profileRoutes.get("/", authorizeRoles("admin", "analyst"), handlers.listProfiles);
profileRoutes.post("/", authorizeRoles("admin"), handlers.createProfile);
profileRoutes.delete("/:id", authorizeRoles("admin"), handlers.deleteProfile);
