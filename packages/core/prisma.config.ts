import { defineConfig } from "prisma/config";
import { homedir } from "os";
import { join } from "path";

const defaultDb = process.env.DATABASE_URL
  ?? `file:${join(homedir(), ".claude", "hook-handler.db")}`;

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url: defaultDb,
  },
});
