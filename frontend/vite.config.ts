import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

import { seoPagesPlugin } from "./scripts/seoPagesPlugin";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), seoPagesPlugin()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      "/api/sam": {
        target: "https://geosense--sam-api-fastapi-app.modal.run",
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/api\/sam/, ""),
      },
    },
  },
});
