import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  target: "es2022",
  outDir: "dist",
  clean: true,
  splitting: false,
  dts: true,
  sourcemap: true,
});
