/**
 * `process.env.NODE_ENV` is the one Node/bundler global we touch (always
 * behind a typeof guard). Declared here instead of depending on @types/node
 * so accidental use of real Node APIs still fails typechecking. Not shipped:
 * tsc does not copy input .d.ts files to dist.
 */
declare var process: { env: { NODE_ENV?: string } } | undefined;
