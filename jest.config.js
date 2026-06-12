/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.spec.ts'],
  moduleFileExtensions: ['ts', 'js'],
  transform: {
    '^.+\\.ts$': ['ts-jest', {
      tsconfig: '<rootDir>/tsconfig.json',
    }],
  },
  coverageDirectory: 'coverage',
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.spec.ts',
    '!src/cli.ts',
    '!src/worker.ts',
    '!src/web-server.ts',
    // Individual provider implementations require live API mocking;
    // coverage for shared utilities in llm-provider.ts + index.ts is tracked.
    '!src/providers/openai.provider.ts',
    '!src/providers/anthropic.provider.ts',
    '!src/providers/google.provider.ts',
    '!src/providers/ollama.provider.ts',
    '!src/providers/azure-openai.provider.ts',
    '!src/providers/qwen.provider.ts',
  ],
  coverageThreshold: {
    global: {
      lines: 80,
      functions: 80,
      branches: 60,
    },
  },
};
