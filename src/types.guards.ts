// Guards the type chain this plugin depends on.
//
// The agent-instructions config this plugin rewrites is only a typed shape while
// `@deepseek-ai/dsh-agent-instructions` is installed: that package ships the
// `Config` type and the augmentation `apply` is typed by. Without it, the
// rewrite silently operates on `any` and the compiler stops checking whether the
// field names still exist.
import type {} from '@deepseek-ai/dsh-agent-instructions'
import type { Config } from '@deepseek-ai/dsh-agent-instructions'
import type { Context } from '@deepseek-ai/cordis'
import type { CandidatesConfig } from './index.js'

/** `'ANY'` when a type collapsed to `any` (its declaration is gone). */
type Verdict<T> = 0 extends 1 & T ? 'ANY' : 'TYPED'

// The candidate lists are the whole point of this plugin; both must stay typed
// and both must still be declared by the official config.
export const configTyped: Verdict<Config> = 'TYPED'
export const rootMarkers: keyof Config = 'projectRootMarkers'

// The two fields `rewriteConfig` reads, as this plugin declares them.
export const candidateField: keyof CandidatesConfig = 'instructionFileCandidates'
export const localCandidateField: keyof CandidatesConfig = 'localInstructionFileCandidates'

// `apply` must keep taking a context (a changed arity would silently stop the
// config waterfall from matching `instructionsApply`).
export const contextSeat: Verdict<Context> = 'TYPED'
