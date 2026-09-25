/**
 * automode 状态 chip 插件，browser half：contributes a status chip to
 * the composer tool row's `conversation.input.left` list slot (the left group
 * beside the permission-preset selector). The chip renders only while the
 * session runs under the `automode` permission preset (read from the official
 * `permissions` projection, so it follows the dropdown reactively) and reads
 * the host runtime state through the mounted `automodeStatus` remote: armed
 * config summary, this turn's deny count, cumulative stats, and the
 * recent-decision history.
 *
 * Remote (not projection) for the runtime state: projection values must fold
 * from session events, and writing custom events trips the session-event
 * allowlist. The preset itself comes from the official projection — no plugin
 * state needed to know whether automode is on.
 */
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the renderer-owned `ctx.slots` service merge.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the ui-session SessionStandardProps merge (branded SessionIdOf).
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { en, zh } from './locales.ts'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
// Type-only: pulls the ui-conversation SlotMap merge (the input.left seat + SessionStandardProps).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { AutomodeChip } from './AutomodeChip.tsx'
import {
  AutomodeSettingsController,
  AutomodeSettingsPage,
  AutomodeSettingsSection,
} from './AutomodeSettingsPage.tsx'
import type { AutomodeStatus, DecisionRecord } from './remote.ts'
import { TYPERT_REMOTE } from './remote.ts'

export type { AutomodeStatus, DecisionRecord } from './remote.ts'

/** Injected business face of the composer status chip. */
export interface AutomodeChipInjected {
  /** Read the current automode status for this session's agent. */
  getStatus: () => Promise<RemoteResult<AutomodeStatus>>
  /** Read the recent automode decisions for this session's agent. */
  getHistory: () => Promise<RemoteResult<DecisionRecord[]>>
}

/** The mounted `remote.automodeStatus` namespace service (resolved via the global store). */
interface AutomodeRemoteNamespace {
  getStatus: (agentId: SessionId) => Promise<RemoteResult<AutomodeStatus>>
  getHistory: (agentId: SessionId) => Promise<RemoteResult<DecisionRecord[]>>
}

/** Required services: the slot registry, the Client Remote mount, the locale registry, and the shared settings forms. */
export const inject = ['slots', 'remote', 'locale', 'configForms']

/** Locale namespace owning this chip's dictionaries (follows the DSH locale setting). */
const LOCALE_NS = 'automode'

/** Profile entry id whose volatile fields the configuration page edits (the bundle patch's row id). */
const ENTRY_NS = 'auto-approval'

/** `plugins.row.config` key: `<bundle package>#<row id>`, as the Plugins page resolves it. */
const ROW_CONFIG_KEY = 'dsh-auto-approval#auto-approval'

/**
 * Client plugin body: mount the host remote contribution, then register the
 * status chip into the composer input-left list slot.
 *
 * The namespace service is read through `ctx.get()` (global store) rather than
 * `ctx.remote.automodeStatus` (per-fiber store chain): `$mount` creates the
 * namespace under the gateway's fiber, a sibling of this plugin — the
 * traceable-proxy path cannot see a sibling-provided service, and declaring it
 * in `inject` would deadlock (the namespace only exists once this apply mounts
 * it). `ctx.get` reads the global reflect store and resolves it directly.
 * @param ctx - client root context.
 */
export async function apply(ctx: ClientContext): Promise<void> {
  // Dictionaries first: the slot registration below declares `locale: LOCALE_NS`,
  // which makes the framework inject the typed `t` seat into the component.
  ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'ui-automode: dictionaries')
  // Mount the host's automodeStatus remote before anything can call it.
  await ctx.remote.$mount(TYPERT_REMOTE)
  const statusRemote = ctx.get('remote.automodeStatus') as AutomodeRemoteNamespace

  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'automode-status',
    locale: LOCALE_NS,
    order: 0,
    inject: (sessionId: SessionId): AutomodeChipInjected => ({
      getStatus: () => statusRemote.getStatus(sessionId),
      getHistory: () => statusRemote.getHistory(sessionId),
    }),
  }, AutomodeChip))

  // Configuration page over this entry's volatile fields (the classifier route
  // pair, backend, guards). One staged form, two homes: a Settings dialog nav
  // entry that exists on every deployment, and the canonical Configure control
  // on the official Plugins page (whose slot only exists when that page is
  // composed). `whileServed` keeps both registrations alive only while the Host
  // serves the entry, so a deployment without the plugin shows no trace.
  const t = ctx.locale.bind(LOCALE_NS)
  const controller = new AutomodeSettingsController(
    ctx.configForms.get<Record<string, unknown>>(ENTRY_NS),
  )
  ctx.effect(() => () => {
    controller.dispose()
  }, 'ui-automode: settings form subscription')
  ctx.effect(() => ctx.configForms.whileServed([ENTRY_NS], () => ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'automode-settings',
    order: 46,
    label: () => t('settings.nav'),
    locale: LOCALE_NS,
    inject: () => controller.face(),
  }, AutomodeSettingsSection))), 'ui-automode: settings section')
  ctx.effect(() => ctx.configForms.whileServed([ENTRY_NS], () => ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
    name: 'plugins.row.config',
    key: ROW_CONFIG_KEY,
    locale: LOCALE_NS,
    inject: () => controller.face(),
  }, AutomodeSettingsPage))), 'ui-automode: plugins row config')
}
