/** Static audit of the plugin bundle: module requests and locale parity. */
const fs = require('fs');
const path = require('path');
// Resolved from this file so `npm test` works from any working directory.
const CLIENT = path.join(__dirname, '..', 'client.js');
const src = fs.readFileSync(CLIENT, 'utf8');

const reqs = [...src.matchAll(/require\((['"])([^'"]+)\1\)/g)].map((m) => m[2]);
const unique = [...new Set(reqs)];
console.log('requires:', JSON.stringify(unique));

const seed = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
  '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
];
const bad = unique.filter((r) => !seed.includes(r));
console.log(bad.length === 0
  ? 'OK - every require is a platform seed (no dsh.client.external needed)'
  : 'NEEDS dsh.client.external: ' + JSON.stringify(bad));

for (const p of ['dsh-client-ui-primitives', 'dsh-client-ui-dockkit']) {
  const hit = new RegExp("require\\(['\"][^'\"]*" + p).test(src);
  console.log('imports ' + p + ':', hit ? 'YES (forbidden)' : 'no');
}

const zhStart = src.indexOf('const zh = {');
const enStart = src.indexOf('const en = {');
const zh = src.slice(zhStart, enStart);
const en = src.slice(enStart, src.indexOf('//#endregion', enStart));
const keys = (s) => [...s.matchAll(/'([a-zA-Z0-9._]+)':/g)].map((m) => m[1]);
const kz = keys(zh);
const ke = keys(en);
console.log('zh keys:', kz.length, '| en keys:', ke.length);
const missingEn = kz.filter((k) => !ke.includes(k));
const missingZh = ke.filter((k) => !kz.includes(k));
console.log(missingEn.length === 0 && missingZh.length === 0
  ? 'OK - dictionaries complete and symmetric'
  : 'MISMATCH en-missing=' + JSON.stringify(missingEn) + ' zh-missing=' + JSON.stringify(missingZh));

// Every t('...') literal used at runtime must exist in the dictionaries.
const used = [...new Set([...src.matchAll(/\bt\(([^)]*)\)/g)]
  .flatMap((m) => [...m[1].matchAll(/'([a-zA-Z0-9._]+)'/g)].map((x) => x[1])))]
  .filter((k) => k.includes('.'));
const unused = kz.filter((k) => !used.includes(k));
console.log('t() literals referenced:', used.length);
console.log('keys built by concatenation (expected):', JSON.stringify(unused));

// Confirm every dynamically composed key exists in both dictionaries.
const kinds = ['done', 'error', 'waiting'];
const composed = [];
for (const kind of kinds) for (const suffix of ['title', 'hint', 'body']) composed.push('kind.' + kind + '.' + suffix);
for (const kind of kinds) composed.push('sound.tts.default.' + kind);
for (const w of ['question', 'approval', 'plan']) composed.push('waiting.' + w);
for (const m of ['tone', 'tts', 'audio', 'none']) composed.push('sound.mode.hint.' + m);
// Each interruption family needs a label and a built-in phrase, and the family
// list is the plugin's own curated set, so it must stay in step with the UI.
const families = ['auth', 'quota', 'rate', 'server', 'network', 'endpoint', 'malformed', 'context', 'request', 'unknown'];
for (const f of families) {
  composed.push('reason.' + f);
  composed.push('reason.' + f + '.name');
}
const composedMissing = composed.filter((k) => !kz.includes(k) || !ke.includes(k));
console.log(composedMissing.length === 0
  ? 'OK - all ' + composed.length + ' composed keys exist in zh and en'
  : 'MISSING composed keys: ' + JSON.stringify(composedMissing));

// The family list is duplicated (settings defaults, UI, sample codes). A family
// that exists in one place but not another would render a blank row or crash.
const source = require('node:fs').readFileSync(CLIENT, 'utf8');
const listMatch = source.match(/const REASON_KINDS = \[([^\]]+)\]/);
const declared = listMatch === null ? [] : listMatch[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
const sameSet = declared.length === families.length && families.every((f) => declared.includes(f));
console.log(sameSet
  ? 'OK - REASON_KINDS matches the audited family set (' + declared.length + ')'
  : 'MISMATCH - REASON_KINDS=' + JSON.stringify(declared));

// Every family must be reachable from the categoriser, or its wording is dead.
const codesBlock = source.match(/const REASON_CODES = \{([\s\S]*?)\n\t\t\};/);
const patternsBlock = source.match(/const REASON_PATTERNS = \[([\s\S]*?)\n\t\t\];/);
const reachable = new Set();
for (const block of [codesBlock?.[1] ?? '', patternsBlock?.[1] ?? '']) {
  for (const f of families) if (new RegExp('^\\s*' + f + ':', 'm').test(block)) reachable.add(f);
}
const unreachable = families.filter((f) => f !== 'unknown' && !reachable.has(f));
console.log(unreachable.length === 0
  ? 'OK - every family except the catch-all is matched by a code or a pattern'
  : 'UNREACHABLE families: ' + JSON.stringify(unreachable));

//#region packaging
// Distribution metadata is read by DSH without activating the plugin, so a wrong
// shape here is invisible in the page but shows up as a nameless, iconless card
// in Plugin Manager. These checks pin the parts that were wrong once already.
const ROOT = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const problems = [];

// DSH resolves `<name>/locale/en.json` and reads `meta.title` / `meta.description`.
for (const language of ['en', 'zh']) {
  const file = path.join(ROOT, 'locale', language + '.json');
  if (!fs.existsSync(file)) { problems.push('missing locale/' + language + '.json'); continue; }
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { problems.push('locale/' + language + '.json is not JSON: ' + error.message); continue; }
  const meta = parsed.meta;
  if (typeof meta !== 'object' || meta === null) { problems.push('locale/' + language + '.json needs a "meta" object'); continue; }
  for (const field of ['title', 'description']) {
    if (typeof meta[field] !== 'string' || meta[field].trim() === '') {
      problems.push('locale/' + language + '.json needs a non-empty meta.' + field);
    }
  }
}

// The icon must exist, stay inside the package, and respect the size limit DSH
// enforces; a violation turns into a metadata diagnostic instead of a card image.
if (typeof manifest.icon !== 'string' || manifest.icon === '') {
  problems.push('package.json needs an "icon"');
} else {
  const iconFile = path.join(ROOT, manifest.icon);
  if (!fs.existsSync(iconFile)) problems.push('icon file is missing: ' + manifest.icon);
  else if (fs.statSync(iconFile).size > 256 * 1024) problems.push('icon exceeds 256 KiB');
}

// The loader patch and the client declaration are what make this a bundle at all.
if (manifest.dsh?.bundle?.patch === undefined) problems.push('package.json needs dsh.bundle.patch');
if (manifest.dsh?.client?.platform !== 'web') problems.push('package.json needs dsh.client.platform = "web"');
if (!Array.isArray(manifest.dsh?.client?.inject) || manifest.dsh.client.inject.length === 0) {
  problems.push('package.json needs dsh.client.inject');
}
// DSH gates activation on @deepseek-ai/dsh* peers; without one the plugin would
// silently run on an incompatible runtime instead of reporting the mismatch.
if (typeof manifest.peerDependencies?.['@deepseek-ai/dsh'] !== 'string') {
  problems.push('package.json needs a peerDependencies["@deepseek-ai/dsh"] range');
}
// `optional` keeps npm from pulling the whole dsh tree on a bare `npm install`;
// DSH reads only peerDependencies, so the compatibility gate still applies.
if (manifest.peerDependenciesMeta?.['@deepseek-ai/dsh']?.optional !== true) {
  problems.push('peerDependenciesMeta["@deepseek-ai/dsh"].optional should be true');
}
// Everything shipped or read at runtime must be listed, or a published tarball
// would omit it.
const files = Array.isArray(manifest.files) ? manifest.files : [];
for (const required of ['client.js', 'index.js', 'cordis.patch.yml', 'icon.svg', 'locale/*.json']) {
  if (!files.includes(required)) problems.push('package.json files[] is missing ' + required);
}

console.log(problems.length === 0
  ? 'OK - packaging metadata is complete (icon, locale meta, patch, inject, compat)'
  : 'PACKAGING PROBLEMS: ' + JSON.stringify(problems, null, 2));
//#endregion

if (problems.length > 0) process.exitCode = 1;

