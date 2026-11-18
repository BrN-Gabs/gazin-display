import { defineConfig } from '@playwright/test';

const PORT = 3100;

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 180_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    // localhost é contexto seguro: service worker e Cache Storage disponíveis
    baseURL: `http://localhost:${PORT}`,
    // Chrome instalado (suporta H.264). Use E2E_CHANNEL=msedge para o Edge.
    channel: process.env.E2E_CHANNEL ?? 'chrome',
    headless: true,
    viewport: { width: 1440, height: 900 },
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npx tsx tests/e2e/e2e-server.ts',
    url: `http://localhost:${PORT}/api/health`,
    timeout: 180_000,
    reuseExistingServer: false,
    stdout: 'pipe',
  },
});
