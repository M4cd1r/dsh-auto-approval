/**
 * Automode preset resolution — the plugin's only switch.
 *
 * This bundle's patch adds a fourth permission preset (`automode`) to the
 * official preset table. It writes the same sandbox/approval knobs as
 * `danger-full-access` (full access + approval `never`) on purpose: the
 * classifier, not the sandbox, gates the session. Selecting any other preset
 * turns the plugin off without a second toggle.
 *
 * The official `permissionPresets` service resolves the effective preset from
 * the session's folded knob state, and a still-matching last
 * `permission/preset` selection wins shared-bundle ties — which is what keeps
 * `automode` and `danger-full-access` distinguishable. The session-log fallback
 * keeps the gate working in compositions without the service.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
// Type-only: pulls the `permission/preset` SessionEventMap merge.
import type {} from '@deepseek-ai/dsh-permission-presets'

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
  if (service !== undefined) {
    try {
      return service.current(session) === AUTOMODE_PRESET
    } catch {
      // A service failure must not silently widen access: fall through to the
      // log-derived answer, which fails closed when it finds nothing.
    }
  }
  return lastPresetName(session) === AUTOMODE_PRESET
}

/** Last `permission/preset` name in the session log, or undefined. */
function lastPresetName(session: Session): string | undefined {
  const events = session.snapshotEvents()
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event !== undefined && event.type === 'permission/preset') return event.data.preset
  }
  return undefined
}
