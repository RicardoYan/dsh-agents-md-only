import { apply as instructionsApply } from '@deepseek-ai/dsh-agent-instructions';
export const name = 'dsh-agents-md-only';
const LOG = '[agents-md-only]';
export const DEFAULT_CANDIDATES = ['AGENTS.md', 'CLAUDE.md'];
export const DEFAULT_LOCAL_CANDIDATES = ['AGENTS.local.md', 'CLAUDE.local.md'];
const DROPPED = new Set(['claude.md', 'claude.local.md']);
/**
 * Drop CLAUDE candidates, keeping everything else verbatim.
 *
 * Non-string entries are deliberately kept: a candidate list is user data, and
 * silently deleting an entry we do not understand would change the config in
 * ways this plugin never intended to own.
 */
const strip = (list, fallback) => (Array.isArray(list) ? list : fallback).filter((file) => typeof file !== 'string' || !DROPPED.has(file.toLowerCase()));
/**
 * Remove CLAUDE.md / CLAUDE.local.md from a resolved agent-instructions config.
 * Exported for tests.
 */
export function rewriteConfig(config) {
    if (config === null || typeof config !== 'object')
        return config;
    const source = config;
    const base = strip(source.instructionFileCandidates, DEFAULT_CANDIDATES);
    const local = strip(source.localInstructionFileCandidates, DEFAULT_LOCAL_CANDIDATES);
    const same = (a, b) => Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);
    if (same(base, source.instructionFileCandidates) && same(local, source.localInstructionFileCandidates)) {
        return config;
    }
    return { ...source, instructionFileCandidates: base, localInstructionFileCandidates: local };
}
export function apply(ctx) {
    if (typeof instructionsApply !== 'function') {
        ctx.logger.warn(`${LOG} dsh-agent-instructions apply missing; nothing changed`);
        return;
    }
    let active = true;
    ctx.on('internal/config', function (first, second) {
        // Cordis 4.0 (DSH <=0.2.1): payload `(rawConfig, next)`, the fiber is `this`.
        // Cordis 4.1 (DSH >=0.2.2): payload `(fiber, next)`, `this` is not the fiber.
        // A fiber is an object carrying `ctx` plus a `runtime`/`uid` pair; a raw
        // config object never has `ctx`. Arg 2 being the `next` callback in both
        // shapes means the payload arity alone cannot distinguish them.
        const looksLikeFiber = first !== null &&
            typeof first === 'object' &&
            typeof first.ctx === 'object' &&
            first.ctx !== null &&
            'uid' in first;
        const fiber = looksLikeFiber ? first : this;
        const next = (looksLikeFiber ? second : first);
        if (typeof next !== 'function')
            return first;
        const out = next();
        if (!active || fiber?.runtime?.callback !== instructionsApply)
            return out;
        return rewriteConfig(out);
    }, { global: true });
    const restartAll = async (reason) => {
        const runtime = ctx.registry.get(instructionsApply);
        let restarted = 0;
        for (const fiber of runtime === undefined ? [] : [...runtime.fibers]) {
            if (fiber.uid === null)
                continue;
            try {
                await fiber.restart();
                restarted++;
            }
            catch (error) {
                ctx.logger.warn(`${LOG} agent-instructions restart failed (${reason}): ${error?.message ?? error}`);
            }
        }
        if (restarted > 0)
            ctx.logger.info(`${LOG} agent-instructions restarted (${reason}): ${restarted}`);
    };
    // Presets are usually mounted before this plugin; restart once the tree settles.
    ctx.inject(['loader'], (c) => {
        // `Loader.await()` waits for pending import/lifecycle tasks. It exists at
        // runtime (`cordis-plugin-loader`'s Loader class) but is absent from the
        // shipped declaration file, so the call is narrowed here rather than cast.
        const loader = c.loader;
        loader.await().then(() => restartAll('install'), () => restartAll('install'));
    });
    ctx.effect(() => () => {
        active = false;
        setTimeout(() => {
            restartAll('uninstall').catch(() => { });
        }, 0);
    }, 'agents-md-only: candidates');
}
