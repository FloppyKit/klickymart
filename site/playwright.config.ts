import { defineConfig } from "@playwright/test";

/** Software WebGL for headless CI (SwiftShader via ANGLE). */
const swiftShaderArgs = [
  "--use-angle=swiftshader",
  "--enable-unsafe-swiftshader",
  "--ignore-gpu-blocklist",
  "--enable-webgl",
  "--disable-dev-shm-usage",
];

export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  use: {
    baseURL: process.env.KM_BASE ?? "http://127.0.0.1:8787",
    launchOptions: {
      args: swiftShaderArgs,
    },
  },
});
