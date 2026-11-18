import path from 'node:path';
import type { TestProject } from 'vitest/node';
import { startTestDatabase } from './test-db.js';

export default async function setup(project: TestProject) {
  const { pg, url } = await startTestDatabase({ port: 54330, name: 'gd_test', dir: path.resolve('.data/test-pg') });
  project.provide('databaseUrl', url);
  return async () => {
    await pg.stop();
  };
}

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}
