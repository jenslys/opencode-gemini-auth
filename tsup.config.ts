import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["index.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  target: "node20",
  noExternal: ["@opencode-ai/plugin", "@openauthjs/openauth"],
});
