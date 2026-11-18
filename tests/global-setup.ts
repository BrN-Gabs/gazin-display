import type { TestProject } from 'vitest/node';
import { startWorker } from './worker-server';

/** Um Worker local (wrangler dev) para todos os testes de integração */
export default async function setup(project: TestProject) {
  const w = await startWorker({ name: 'test-worker', port: 8788 });
  project.provide('baseUrl', w.baseUrl);
  return async () => {
    await w.stop();
  };
}

declare module 'vitest' {
  export interface ProvidedContext {
    baseUrl: string;
  }
}
