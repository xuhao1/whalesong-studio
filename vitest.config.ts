// SPDX-License-Identifier: LGPL-3.0-or-later
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
  },
  define: {
    __NOVEL_VERSION__: JSON.stringify('test'),
    __NOVEL_PACKAGE__: JSON.stringify('whalesong-studio'),
    __NOVEL_LICENSE__: JSON.stringify('LGPL-3.0-or-later'),
  },
})
