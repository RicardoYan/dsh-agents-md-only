// Self-test for dsh-agents-md-only. Run with DSH's bundled node:
//   node test/selftest.mjs
// Official packages are resolved from DSH_PACKAGES (the DSH install's
// node_modules), so the repository needs no node_modules of its own.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

const PACKAGES = process.env.DSH_PACKAGES;
if (!PACKAGES || !fs.existsSync(PACKAGES)) {
  console.log('set DSH_PACKAGES to the directory holding @deepseek-ai/* (DSH install node_modules)');
  process.exit(2);
}
const anchor = pathToFileURL(path.join(PACKAGES, '__anchor__.js')).href;
registerHooks({
  resolve(specifier, context, next) {
    try { return next(specifier, context); } catch (error) {
      if (/^[@a-z]/i.test(specifier) && !specifier.startsWith('node:')) return next(specifier, { ...context, parentURL: anchor });
      throw error;
    }
  },
});

const plugin = await import('../lib/index.js');
const { rewriteConfig } = plugin;
const instructions = await import('@deepseek-ai/dsh-agent-instructions');
const { Context } = await import('@deepseek-ai/cordis');

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) passed++;
  else failures.push(`${label}\n    expected ${JSON.stringify(expected)}\n    actual   ${JSON.stringify(actual)}`);
}
const tick = () => new Promise((r) => setTimeout(r, 10));
const lists = (c) => [c.instructionFileCandidates, c.localInstructionFileCandidates];
const ONLY = [['AGENTS.md'], ['AGENTS.local.md']];

// ---------------------------------------------------------------- rewriteConfig
{
  check('rewrite: defaults', lists(rewriteConfig({ maxBytes: 1 })), ONLY);
  check('rewrite: keeps other fields', rewriteConfig({ maxBytes: 7, projectRootMarkers: ['.git'] }).projectRootMarkers, ['.git']);
  check('rewrite: explicit lists', lists(rewriteConfig({ instructionFileCandidates: ['CLAUDE.md', 'TEAM.md', 'AGENTS.md'], localInstructionFileCandidates: ['claude.local.md'] })), [['TEAM.md', 'AGENTS.md'], []]);
  check('rewrite: case-insensitive', lists(rewriteConfig({ instructionFileCandidates: ['Claude.MD'], localInstructionFileCandidates: [] })), [[], []]);
  const clean = { instructionFileCandidates: ['AGENTS.md'], localInstructionFileCandidates: ['AGENTS.local.md'] };
  check('rewrite: unchanged object kept', rewriteConfig(clean) === clean, true);
  check('rewrite: non-object passthrough', rewriteConfig(null), null);
}

// ---------------------------------------------------------------- real discovery
{
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agmd-')));
  const home = path.join(tmp, 'home');
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  for (const [f, s] of [['AGENTS.md', 'a'], ['CLAUDE.md', 'c'], ['AGENTS.local.md', 'al'], ['CLAUDE.local.md', 'cl']]) fs.writeFileSync(path.join(repo, f), s);
  const found = async (cfg) => (await instructions.discoverBaselineInstructionFiles({ cwd: repo, dshHome: home, ...cfg })).map((f) => f.displayPath);
  check('discover: official default reads CLAUDE', await found({}), ['AGENTS.md', 'CLAUDE.md', 'AGENTS.local.md', 'CLAUDE.local.md']);
  check('discover: rewritten reads AGENTS only', await found(rewriteConfig({ maxBytes: 1 })), ['AGENTS.md', 'AGENTS.local.md']);
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---------------------------------------------------------------- real cordis lifecycle
{
  const root = new Context();
  root.plugin({ name: 'loader', apply: (ctx) => { ctx.provide('loader', { await: async () => {} }); } });
  await tick();
  // A preset-style instance mounted before this plugin, with only maxBytes.
  const fiberOf = () => [...root.registry.get(instructions.apply).fibers][0];
  root.plugin({ name: 'agent-instructions', apply: instructions.apply, Config: instructions.Config }, { maxBytes: 65536 });
  await tick();
  check('cordis: before install', lists(fiberOf().config), [['AGENTS.md', 'CLAUDE.md'], ['AGENTS.local.md', 'CLAUDE.local.md']]);

  // Other plugins hooking the same config (dsh-project-config inserts a root marker).
  root.on('internal/config', function (raw, next) {
    const out = next();
    if (this?.runtime?.callback !== instructions.apply) return out;
    return { ...out, projectRootMarkers: ['.dsh/settings.yml', ...(out.projectRootMarkers ?? ['.git'])] };
  }, { global: true });

  const fiber = root.plugin(plugin, {});
  await tick();
  check('cordis: restarted on install', lists(fiberOf().config), ONLY);
  check('cordis: coexists with other hook', fiberOf().config.projectRootMarkers, ['.dsh/settings.yml', '.git']);
  check('cordis: maxBytes kept', fiberOf().config.maxBytes, 65536);
  check('cordis: one instance', root.registry.get(instructions.apply).fibers.length, 1);

  // Instances mounted later are rewritten too.
  root.plugin({ name: 'agent-instructions', apply: instructions.apply, Config: instructions.Config }, { maxBytes: 1024 });
  await tick();
  const later = [...root.registry.get(instructions.apply).fibers][1];
  check('cordis: later instance', lists(later.config), ONLY);

  // Other plugins' config untouched.
  let seen;
  root.plugin({ name: 'other', apply: (_ctx, cfg) => { seen = cfg; } }, { instructionFileCandidates: ['CLAUDE.md'] });
  await tick();
  check('cordis: other plugins untouched', seen.instructionFileCandidates, ['CLAUDE.md']);

  await fiber.dispose();
  await tick(); await tick();
  check('cordis: restored on uninstall', lists(fiberOf().config), [['AGENTS.md', 'CLAUDE.md'], ['AGENTS.local.md', 'CLAUDE.local.md']]);
  check('cordis: other hook still applies', fiberOf().config.projectRootMarkers, ['.dsh/settings.yml', '.git']);

  // enabled: false leaves everything alone.
  const off = root.plugin(plugin, { enabled: false });
  await tick(); await tick();
  check('cordis: disabled by config', lists(fiberOf().config), [['AGENTS.md', 'CLAUDE.md'], ['AGENTS.local.md', 'CLAUDE.local.md']]);
  await off.dispose();
}

if (failures.length) {
  console.log(failures.map((f) => `FAIL ${f}`).join('\n'));
  console.log(`${passed} passed, ${failures.length} failed`);
  process.exit(1);
}
console.log(`${passed} passed`);
