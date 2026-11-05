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
 *   its config; `ctx.registry.get(apply).fibers` lists the running instances and
 *   `fiber.restart()` re-resolves the config. Cordis 4.1 (DSH 0.2.2) hands the
 *   fiber as the FIRST payload argument (`(fiber, next)`), while 4.0 handed it
 *   as `this` and passed the raw config first. Both are handled below so the
 *   plugin keeps working on either line.
 * - agent-instructions keys its baseline on the candidate lists, so a session that
 *   continues after install / uninstall receives one replacement baseline.
 */
import type { Context, Fiber } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { apply as instructionsApply } from '@deepseek-ai/dsh-agent-instructions'

export const name = 'dsh-agents-md-only'

const LOG = '[agents-md-only]'
export const DEFAULT_CANDIDATES = ['AGENTS.md', 'CLAUDE.md']
export const DEFAULT_LOCAL_CANDIDATES = ['AGENTS.local.md', 'CLAUDE.local.md']
const DROPPED = new Set(['claude.md', 'claude.local.md'])

/** The two config fields this plugin rewrites, as agent-instructions declares them. */
export interface CandidatesConfig {
  instructionFileCandidates?: unknown
  localInstructionFileCandidates?: unknown
}

/**
 * Drop CLAUDE candidates, keeping everything else verbatim.
 *
 * Non-string entries are deliberately kept: a candidate list is user data, and
 * silently deleting an entry we do not understand would change the config in
 * ways this plugin never intended to own.
 */
const strip = (list: unknown, fallback: string[]): unknown[] =>
  (Array.isArray(list) ? (list as unknown[]) : fallback).filter(
    (file) => typeof file !== 'string' || !DROPPED.has(file.toLowerCase()),
  )

/**
 * Remove CLAUDE.md / CLAUDE.local.md from a resolved agent-instructions config.
 * Exported for tests.
 */
export function rewriteConfig<T>(config: T): T {
  if (config === null || typeof config !== 'object') return config
  const source = config as CandidatesConfig
  const base = strip(source.instructionFileCandidates, DEFAULT_CANDIDATES)
  const local = strip(source.localInstructionFileCandidates, DEFAULT_LOCAL_CANDIDATES)
  const same = (a: unknown[], b: unknown): boolean =>
    Array.isArray(b) && a.length === b.length && a.every((x, i) => x === (b as unknown[])[i])
  if (same(base, source.instructionFileCandidates) && same(local, source.localInstructionFileCandidates)) {
    return config
  }
  return { ...source, instructionFileCandidates: base, localInstructionFileCandidates: local } as T
}

export function apply(ctx: Context): void {
  if (typeof instructionsApply !== 'function') {
    ctx.logger.warn(`${LOG} dsh-agent-instructions apply missing; nothing changed`)
    return
  }

  let active = true
  ctx.on(
    'internal/config',
    function (this: Fiber, first: unknown, second?: unknown) {
      // Cordis 4.0 (DSH <=0.2.1): payload `(rawConfig, next)`, the fiber is `this`.
      // Cordis 4.1 (DSH >=0.2.2): payload `(fiber, next)`, `this` is not the fiber.
      // A fiber is an object carrying `ctx` plus a `runtime`/`uid` pair; a raw
      // config object never has `ctx`. Arg 2 being the `next` callback in both
      // shapes means the payload arity alone cannot distinguish them.
      const looksLikeFiber =
        first !== null &&
        typeof first === 'object' &&
        typeof (first as { ctx?: unknown }).ctx === 'object' &&
        (first as { ctx?: unknown }).ctx !== null &&
        'uid' in (first as object)
      const fiber = looksLikeFiber ? (first as Fiber) : this
      const next = (looksLikeFiber ? second : first) as (() => any) | undefined
      if (typeof next !== 'function') return first
      const out = next()
      if (!active || fiber?.runtime?.callback !== instructionsApply) return out
      return rewriteConfig(out)
    },
    { global: true },
  )

  const restartAll = async (reason: string): Promise<void> => {
    const runtime = ctx.registry.get(instructionsApply)
    let restarted = 0
    for (const fiber of runtime === undefined ? [] : [...runtime.fibers]) {
      if (fiber.uid === null) continue
      try {
        await fiber.restart()
        restarted++
      } catch (error) {
        ctx.logger.warn(
          `${LOG} agent-instructions restart failed (${reason}): ${(error as { message?: unknown } | undefined)?.message ?? error}`,
        )
      }
    }
    if (restarted > 0) ctx.logger.info(`${LOG} agent-instructions restarted (${reason}): ${restarted}`)
  }

  // Presets are usually mounted before this plugin; restart once the tree settles.
  ctx.inject(['loader'], (c) => {
    // `Loader.await()` waits for pending import/lifecycle tasks. It exists at
    // runtime (`cordis-plugin-loader`'s Loader class) but is absent from the
    // shipped declaration file, so the call is narrowed here rather than cast.
    const loader = c.loader as unknown as { await(): Promise<void> }
    loader.await().then(
      () => restartAll('install'),
      () => restartAll('install'),
    )
  })
  ctx.effect(
    () => () => {
      active = false
      setTimeout(() => {
        restartAll('uninstall').catch(() => {})
      }, 0)
    },
    'agents-md-only: candidates',
  )
}
