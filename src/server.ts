import "dotenv/config";
import { createApp } from "./app";
import { initializeDatabase } from "./db";
import { PORT } from "./config";

const app = createApp();

const startServer = async (): Promise<void> => {
  await initializeDatabase();
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
};

startServer().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});

export default app;
