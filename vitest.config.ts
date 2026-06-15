import { defineConfig } from 'vitest/config';

// Unit tests live next to the TypeScript sources they cover (tools/*/src/**.test.ts). The Python
// analysis package is tested separately with pytest, so it is excluded here.
export default defineConfig({
  test: {
    include: ['tools/**/src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'tools/analysis/**'],
  },
});
