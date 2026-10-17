/**
 * dsh-agents-md-only — DSH reads only AGENTS.md / AGENTS.local.md as workspace
 * instructions, never CLAUDE.md / CLAUDE.local.md.
 *
 * DSH interfaces relied on (@deepseek-ai/dsh 0.2.x):
 * - @deepseek-ai/dsh-agent-instructions: config fields `instructionFileCandidates`
 *   (default `['AGENTS.md', 'CLAUDE.md']`) and `localInstructionFileCandidates`
 *   (default `['AGENTS.local.md', 'CLAUDE.local.md']`). The Web presets mount their
 *   own instance with only `maxBytes`, and a profile patch cannot address rows
 *   inside a preset, so the change is made at config resolution instead.
 * - cordis: the global `internal/config` waterfall runs whenever a fiber resolves
 *   its config (`this` is the fiber, `this.runtime.callback` the plugin's apply);
 *   `ctx.registry.get(apply).fibers` lists the running instances and
 *   `fiber.restart()` re-resolves the config.
 * - agent-instructions keys its baseline on the candidate lists, so a session that
 *   continues after install / uninstall receives one replacement baseline.
 */
import { apply as instructionsApply } from '@deepseek-ai/dsh-agent-instructions';

export const name = 'dsh-agents-md-only';

const LOG = '[agents-md-only]';
export const DEFAULT_CANDIDATES = ['AGENTS.md', 'CLAUDE.md'];
export const DEFAULT_LOCAL_CANDIDATES = ['AGENTS.local.md', 'CLAUDE.local.md'];
const DROPPED = new Set(['claude.md', 'claude.local.md']);

const strip = (list, fallback) => (Array.isArray(list) ? list : fallback)
  .filter((file) => typeof file !== 'string' || !DROPPED.has(file.toLowerCase()));

/** Remove CLAUDE.md / CLAUDE.local.md from a resolved agent-instructions config. Exported for tests. */
export function rewriteConfig(config) {
  if (config === null || typeof config !== 'object') return config;
  const base = strip(config.instructionFileCandidates, DEFAULT_CANDIDATES);
  const local = strip(config.localInstructionFileCandidates, DEFAULT_LOCAL_CANDIDATES);
  const same = (a, b) => Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);
  if (same(base, config.instructionFileCandidates) && same(local, config.localInstructionFileCandidates)) return config;
  return { ...config, instructionFileCandidates: base, localInstructionFileCandidates: local };
}

export function apply(ctx) {
  if (typeof instructionsApply !== 'function') {
    ctx.logger.warn(`${LOG} dsh-agent-instructions apply missing; nothing changed`);
    return;
  }

  let active = true;
  ctx.on('internal/config', function (raw, next) {
    const out = next();
    if (!active || this?.runtime?.callback !== instructionsApply) return out;
    return rewriteConfig(out);
  }, { global: true });

  const restartAll = async (reason) => {
    const runtime = ctx.registry.get(instructionsApply);
    let restarted = 0;
    for (const fiber of runtime ? [...runtime.fibers] : []) {
      if (fiber.uid === null) continue;
      try { await fiber.restart(); restarted++; } catch (error) {
        ctx.logger.warn(`${LOG} agent-instructions restart failed (${reason}): ${error?.message ?? error}`);
      }
    }
    if (restarted) ctx.logger.info(`${LOG} agent-instructions restarted (${reason}): ${restarted}`);
  };

  // Presets are usually mounted before this plugin; restart once the tree settles.
  ctx.inject(['loader'], (c) => {
    c.loader.await().then(() => restartAll('install'), () => restartAll('install'));
  });
  ctx.effect(() => () => {
    active = false;
    setTimeout(() => { restartAll('uninstall').catch(() => {}); }, 0);
  }, 'agents-md-only: candidates');
}
