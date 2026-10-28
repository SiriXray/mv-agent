import fs from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {parseEnv} from 'node:util';

// Inspect the index, not arbitrary working-tree files. Never print credential values.
const git = args => execFileSync('git', args, {encoding:'utf8', maxBuffer:8*1024*1024, windowsHide:true});
const files = git(['ls-files','--cached','-z']).split('\0').filter(Boolean);
if (!files.length) throw new Error('Stage the intended source files before running this check.');
const secretName = /(?:api[_-]?key|secret|password|token|_key)$/i;
const known = new Set();
async function optional(file) { try { return await fs.readFile(file,'utf8'); } catch(e) { if(e.code==='ENOENT') return ''; throw e; } }
const localEnv = parseEnv(await optional('.env'));
for(const [key,value] of Object.entries(localEnv)) if(secretName.test(key) && value.length>=8) known.add(value);
function collect(value) {
  if(!value || typeof value!=='object')return;
  for(const [key,item] of Object.entries(value)) {
    if(secretName.test(key) && typeof item==='string' && item.length>=8)known.add(item);
    else if(item && typeof item==='object')collect(item);
  }
}
const config = await optional('data/ai-settings.json');
if(config) { let parsed; try { parsed=JSON.parse(config); } catch { throw new Error('Cannot parse local AI settings safely for the repository check.'); } collect(parsed); }
const patterns = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ['api-key-format', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{24,}\b/],
  ['aws-access-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
];
const findings=[];
let bytes=0;
for(const file of files) {
  if(!/^(?:\.env\.example|\.gitignore|README\.md|package\.json|server\.mjs|(?:lib|public|tests|tools)\/)/.test(file) || /(?:^|\/)(?:data|artifacts|design-preview|source-notes|node_modules|__pycache__)(?:\/|$)/.test(file) || /\.(?:mp4|mp3|wav|m4a|flac|ogg|pem|key|pyc|log)$/i.test(file))findings.push({file,rule:'outside-source-scope'});
  const content=git(['show',':'+file]);bytes+=Buffer.byteLength(content);
  if(content.includes('\0'))findings.push({file,rule:'binary-file'});
  if(Buffer.byteLength(content)>2*1024*1024)findings.push({file,rule:'large-file'});
  if([...known].some(value=>content.includes(value)))findings.push({file,rule:'local-credential-match'});
  for(const [rule,pattern] of patterns)if(pattern.test(content))findings.push({file,rule});
  if(file==='.env.example')for(const [key,value] of Object.entries(parseEnv(content)))if(secretName.test(key)&&value)findings.push({file,rule:'nonempty-example-credential'});
}
console.log(JSON.stringify({status:findings.length?'failed':'passed',files:files.length,bytes,findings},null,2));
if(findings.length)process.exitCode=1;
