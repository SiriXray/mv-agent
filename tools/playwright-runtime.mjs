import {createRequire} from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
// Prefer an explicit module, then a project installation; preserve the optional desktop runtime.
export function loadPlaywright() {
  if (process.env.MV_PLAYWRIGHT_MODULE) return require(process.env.MV_PLAYWRIGHT_MODULE);
  let modulePath;
  try { modulePath = require.resolve('playwright'); }
  catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
  if (modulePath) return require(modulePath);
  const bundled = path.join(os.homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node', 'node_modules', 'playwright');
  try { modulePath = require.resolve(bundled); }
  catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    throw new Error('Browser tests require Playwright. Install playwright and its Chromium browser, or set MV_PLAYWRIGHT_MODULE to an existing installation.');
  }
  return require(modulePath);
}
