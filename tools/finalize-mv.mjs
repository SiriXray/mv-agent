import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {finalizeMv} from '../lib/av-sync.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
try {
  const result = await finalizeMv(path.join(root, 'data'), process.argv[2] || '');
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(JSON.stringify({error: error.message})); process.exitCode = 1;
}
