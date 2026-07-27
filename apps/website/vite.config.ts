import { defineConfig } from "vite";

export default defineConfig({
  build: {
    cssCodeSplit: false,
    sourcemap: false,
    target: "es2022",
  },
});
