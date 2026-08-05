import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // GitHub project pages are served from /<repository-name>/.
  base: process.env.VITE_BASE_PATH || "/partmaster/",
});
