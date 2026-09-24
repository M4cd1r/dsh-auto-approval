/**
 * Automode preset resolution — the plugin's only switch.
 *
 * This bundle's patch adds a fourth permission preset (`automode`) to the
 * official preset table. It writes the same sandbox/approval knobs as
 * `danger-full-access` (full access + approval `never`) on purpose: the
 * classifier, not the sandbox, gates the session. Selecting any other preset
 * turns the plugin off without a second toggle.
 *
 * The official `permissionPresets` service is the sole source of truth: it
 * resolves the effective preset from the session's folded knob state, and a
 * still-matching last `permission/preset` selection wins shared-bundle ties —
 * which is what keeps `automode` and `danger-full-access` distinguishable.
 * The session-log fallback is gone (DSH 0.1.7 deprecated synchronous history
 * reads): compositions without the service do not run automode.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'

/** The preset table key this plugin owns. */
export const AUTOMODE_PRESET = 'automode'

/** The slice of the official service this plugin reads (structural, test-friendly). */
export interface PresetReader {
  /** Resolve one session's effective preset name (or `custom`). */
  current(session: Session): string
}

/**
 * Whether one session currently runs under the automode preset.
 * @param ctx - plugin context used to resolve the optional official service.
 * @param session - the session behind the tool call; absent means no gate.
 * @returns true only when the effective preset is `automode`.
 */
export function isAutomode(ctx: Context, session: Session | undefined): boolean {
  if (session === undefined) return false
  const service = ctx.get('permissionPresets') as PresetReader | undefined
  if (service === undefined) return false
  try {
    return service.current(session) === AUTOMODE_PRESET
  } catch {
    // A service failure must not silently widen access: fail closed to
    // "plugin off" rather than guessing from history.
    return false
  }
}
