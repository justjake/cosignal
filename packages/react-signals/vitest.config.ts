import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./test/setup.ts'],
    environmentMatchGlobs: [
      ['test/react*.test.tsx', 'jsdom'],
      ['test/mutation-observer.test.tsx', 'jsdom'],
      ['test/patch-smoke.test.ts', 'jsdom'],
      ['test/**', 'node'],
    ],
  },
});
