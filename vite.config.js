import { defineConfig } from "vite";

export default defineConfig({
  base: "/scribe/",
  build: {
    target: "esnext",
  },
  worker: {
    format: "es",
  },
});
