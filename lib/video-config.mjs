import fs from 'node:fs';
import {parseEnv} from 'node:util';

const fields = ['ENABLE_LIVE_GENERATION', 'VIDU_API_KEY', 'VIDU_PREVIEW_API_KEY', 'DASHSCOPE_API_KEY', 'WAN_API_KEY', 'DASHSCOPE_BACKUP_API_KEY', 'MINIMAX_KEY', 'SEEDANCE_API_KEY', 'SEEDANCE_BASE_URL', 'REVERSE_PROMPT_URL', 'REVERSE_PROMPT_MODEL'];
export function reloadVideoEnv(file, env) {
  if (!file || !fs.existsSync(file)) return false;
  const saved = parseEnv(fs.readFileSync(file, 'utf8'));
  for (const name of fields) if (Object.hasOwn(saved, name)) env[name] = saved[name];
  return true;
}
