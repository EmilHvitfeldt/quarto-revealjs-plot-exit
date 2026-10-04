import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests",
  timeout: 15000,
  workers: 1,
  webServer: {
    command: "python3 -m http.server 4791",
    port: 4791,
    reuseExistingServer: true,
  },
  use: {
    baseURL: "http://localhost:4791",
  },
});
