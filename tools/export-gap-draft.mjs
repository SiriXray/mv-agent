import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {exportGapDraft} from '../lib/gap-draft.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
try {
  const result = await exportGapDraft(path.join(root, 'data'), process.argv[2] || '', {allowGaps: process.argv.includes('--allow-gaps')});
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(JSON.stringify({error: error.message})); process.exitCode = 1;
}
