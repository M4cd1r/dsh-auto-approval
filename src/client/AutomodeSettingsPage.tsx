/**
 * Automode's configuration page, browser half.
 *
 * DSH 0.1.7 exposes every `.volatile()` profile-entry field through the shared
 * settings-form seam (`ctx.configForms`, served by `ui-settings`), but ships no
 * client that renders those forms — a plugin that wants a GUI contributes its
 * own page. This file builds that page once (staged edits, override badges,
 * one Save) and registers it in the two places a configuration page lives:
 *
 * - `settings.section` — a first-class entry in the Settings dialog's nav, so
 *   the form exists even when the official Plugins page is not composed;
 * - `plugins.row.config` — the canonical **Configure** control on the official
 *   Plugins page, keyed `<bundle package>#<row id>`; the slot's owner (the
 *   plugin manager) renders it only when it is composed, and `whileServed`
 *   keeps both registrations alive only while the Host serves this entry.
 *
 * The Host is the authority on every write: an update its validators refuse
 * (e.g. a fast provider without its model) keeps the last good config, and the
 * form reports the failed save instead of dropping the drafts.
 */
import { useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import {
  SettingsForm,
  SettingsFormModel,
  SettingsValueField,
  settingsTextField,
  Switch,
  Tag,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  SettingsFieldSpec,
  SettingsFieldState,
  SettingsFormScope,
  SettingsFormShell,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

/* ------------------------------------------------------------------ */
/* Local mirrors of seams owned by other packages                      */
/* ------------------------------------------------------------------ */

/**
 * Owner props the official Plugins page passes to a `plugins.row.config`
 * entry. Mirrored here (instead of `import type` from the plugin-manager
 * package) so this plugin keeps no dependency on the manager; the live values
 * are wider than this view, which is all the component reads.
 */
export interface PluginsRowConfigOwner {
  /** `summary` is the one-liner; `page` is the form. */
  readonly view: 'summary' | 'page'
  /** The page's own Host-backed form; unused here — this page stages itself. */
  readonly form?: unknown
}

/** The Host settings-form write seam this page stages over (owned by `ui-settings`). */
interface ClientConfigForms {
  /** @param entryId - profile entry id whose volatile fields this form edits. */
  get<T>(entryId: string): SettingsFormScope<T>
  /**
   * Keep a registration alive while the Host serves some namespaces.
   * @param namespaces - namespaces the registration follows.
   * @param register - registers once served; returns its disposer.
   * @returns the disposer ending the watch and any live registration.
   */
  whileServed(namespaces: readonly string[], register: (served: ReadonlySet<string>) => () => void): () => void
  /** The shared describe mirror's read face (the served-namespace directory). */
  describe(): { readonly getSnapshot?: () => unknown }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Shared configuration forms keyed by profile entry id (from `ui-settings`). */
    configForms: ClientConfigForms
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** The Settings dialog's nav entries (owner: `ui-settings` shell). */
    'settings.section': { kind: 'list'; scope: 'root' }
    /** One row's configuration page on the official Plugins page (owner: plugin manager). */
    'plugins.row.config': { kind: 'keyed'; scope: 'root'; owner: PluginsRowConfigOwner }
  }
}

/* ------------------------------------------------------------------ */
/* Field specs                                                         */
/* ------------------------------------------------------------------ */

/** A whole-number field: empty clears, anything else must parse finite. */
function integerField(field: string): SettingsFieldSpec {
  return {
    field,
    format: (value) => (typeof value === 'number' && Number.isFinite(value) ? String(value) : ''),
    parse: (text) => {
      const trimmed = text.trim()
      if (trimmed === '') return { kind: 'clear' }
      const value = Number(trimmed)
      return Number.isInteger(value) ? { kind: 'set', value } : undefined
    },
  }
}

/** A positive-float field (thresholds): empty clears, non-numbers block the save. */
function floatField(field: string): SettingsFieldSpec {
  return {
    field,
    format: (value) => (typeof value === 'number' && Number.isFinite(value) ? String(value) : ''),
    parse: (text) => {
      const trimmed = text.trim()
      if (trimmed === '') return { kind: 'clear' }
      const value = Number(trimmed)
      return Number.isFinite(value) ? { kind: 'set', value } : undefined
    },
  }
}

/** A closed-vocabulary field (`llm` / `jev`): anything else blocks the save. */
function enumField(field: string, allowed: readonly string[]): SettingsFieldSpec {
  return {
    field,
    format: (value) => (typeof value === 'string' && allowed.includes(value) ? value : ''),
    parse: (text) => {
      const trimmed = text.trim()
      if (trimmed === '') return { kind: 'clear' }
      return allowed.includes(trimmed) ? { kind: 'set', value: trimmed } : undefined
    },
  }
}

/** A boolean field staged as text, so it rides the same save as every other field. */
function booleanField(field: string): SettingsFieldSpec {
  return {
    field,
    format: (value) => (typeof value === 'boolean' ? String(value) : ''),
    parse: (text) => {
      const trimmed = text.trim().toLowerCase()
      if (trimmed === '') return { kind: 'clear' }
      if (trimmed === 'true') return { kind: 'set', value: true }
      if (trimmed === 'false') return { kind: 'set', value: false }
      return undefined
    },
  }
}

/** A string-list field edited one item per line; an empty draft re-inherits the defaults. */
function listField(field: string): SettingsFieldSpec {
  return {
    field,
    format: (value) => (Array.isArray(value) ? value.map((item) => String(item)).join('\n') : ''),
    parse: (text) => {
      if (text.trim() === '') return { kind: 'clear' }
      const items = text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
      return { kind: 'set', value: items }
    },
  }
}

/** Every field this page edits, in render order's spec table. */
const SPECS: readonly SettingsFieldSpec[] = [
  settingsTextField('classifierFastProvider'),
  settingsTextField('classifierFastModel'),
  settingsTextField('classifierDeepProvider'),
  settingsTextField('classifierDeepModel'),
  enumField('classifierBackend', ['llm', 'jev']),
  integerField('classifierTimeoutMs'),
  settingsTextField('classifierGuidance'),
  settingsTextField('jevApiKey'),
  settingsTextField('jevBaseUrl'),
  settingsTextField('jevModel'),
  floatField('jevAllowThreshold'),
  booleanField('selfKillGuard'),
  booleanField('auditSessionEvents'),
  listField('denyPatterns'),
  listField('askPatterns'),
  listField('autoApproveTools'),
  listField('bashCommandPrefixes'),
]

/* ------------------------------------------------------------------ */
/* Controller                                                          */
/* ------------------------------------------------------------------ */

/** One staged field as the control renders it. */
type FieldState = SettingsFieldState

/** The observable the page subscribes to (the form model's snapshot store). */
export interface SettingsStore {
  getSnapshot(): AutomodeSettingsState
  subscribe(listener: () => void): () => void
}

/** Card-level state every settings page shares, plus this page's staged fields. */
export interface AutomodeSettingsState extends SettingsFormShell {
  readonly fastProvider: FieldState
  readonly fastModel: FieldState
  readonly deepProvider: FieldState
  readonly deepModel: FieldState
  readonly backend: FieldState
  readonly timeout: FieldState
  readonly guidance: FieldState
  readonly jevApiKey: FieldState
  readonly jevBaseUrl: FieldState
  readonly jevModel: FieldState
  readonly jevThreshold: FieldState
  readonly selfKillGuard: FieldState
  readonly auditSessionEvents: FieldState
  readonly denyPatterns: FieldState
  readonly askPatterns: FieldState
  readonly autoApproveTools: FieldState
  readonly bashCommandPrefixes: FieldState
}

/** The registrant's business face: the staged-form store plus the form actions. */
export interface AutomodeSettingsInjection {
  readonly store: SettingsStore
  readonly edit: (field: string, text: string) => void
  readonly resetField: (field: string) => void
  readonly save: () => void
  readonly discard: () => void
}

/**
 * Bridges one entry's shared Host form onto the page: stages what the user
 * types, publishes one projection the component subscribes to, and hands the
 * save/discard actions to both registrations.
 */
export class AutomodeSettingsController {
  private readonly model: SettingsFormModel<Record<string, unknown>>
  private readonly store: SettingsStore

  /**
   * @param scope - the entry's shared config form (`ctx.configForms.get`).
   */
  constructor(scope: SettingsFormScope<Record<string, unknown>>) {
    this.model = new SettingsFormModel<Record<string, unknown>>(scope, [...SPECS])
    this.store = this.model.bind(() => this.projection())
  }

  /** Build the face the slot registrations inject. */
  face(): AutomodeSettingsInjection {
    return { store: this.store, ...this.model.actions() }
  }

  /** Release the form's Host subscription. */
  dispose(): void {
    this.model.dispose()
  }

  /** Rebuild the page's snapshot from the form model (stable until a change). */
  private projection(): AutomodeSettingsState {
    const field = (name: string): FieldState => this.model.field(name)
    return {
      ...this.model.shell(),
      fastProvider: field('classifierFastProvider'),
      fastModel: field('classifierFastModel'),
      deepProvider: field('classifierDeepProvider'),
      deepModel: field('classifierDeepModel'),
      backend: field('classifierBackend'),
      timeout: field('classifierTimeoutMs'),
      guidance: field('classifierGuidance'),
      jevApiKey: field('jevApiKey'),
      jevBaseUrl: field('jevBaseUrl'),
      jevModel: field('jevModel'),
      jevThreshold: field('jevAllowThreshold'),
      selfKillGuard: field('selfKillGuard'),
      auditSessionEvents: field('auditSessionEvents'),
      denyPatterns: field('denyPatterns'),
      askPatterns: field('askPatterns'),
      autoApproveTools: field('autoApproveTools'),
      bashCommandPrefixes: field('bashCommandPrefixes'),
    }
  }
}

/* ------------------------------------------------------------------ */
/* Components                                                          */
/* ------------------------------------------------------------------ */

/** Translate function of the `automode` locale namespace. */
type T = TranslateNS<'automode'>

/** Shared badge/reset copy resolved from the page's dictionary. */
interface FieldCopy {
  readonly overridden: string
  readonly reset: string
  readonly invalid: string
}

/** Props of the configuration page: the injected face + owner share + locale seat. */
export interface AutomodeSettingsPageProps extends AutomodeSettingsInjection {
  readonly t: T
  readonly view?: 'summary' | 'page'
  readonly form?: unknown
}

/** Group heading between field blocks. */
function GroupHeading({ children }: { readonly children: ReactNode }): ReactNode {
  return (
    <h3 style={{ margin: '10px 0 0', fontSize: 14, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }}>
      {children}
    </h3>
  )
}

/** One single-line value control with its override badge and reset. */
function TextRow(props: {
  readonly id: string
  readonly label: string
  readonly hint: string
  readonly invalidLabel: string
  readonly state: FieldState
  readonly copy: FieldCopy
  readonly disabled: boolean
  readonly numeric?: boolean
  readonly onEdit: (text: string) => void
  readonly onReset: () => void
}): ReactNode {
  const numeric = props.numeric ?? false
  return (
    <SettingsValueField
      id={props.id}
      label={props.label}
      hint={props.hint}
      text={props.state.text}
      overridden={props.state.overridden}
      invalid={props.state.invalid}
      overriddenLabel={props.copy.overridden}
      resetLabel={props.copy.reset}
      invalidLabel={props.invalidLabel}
      disabled={props.disabled}
      {...numeric ? { numeric: true } : {}}
      onEdit={props.onEdit}
      onReset={props.onReset}
    />
  )
}

/** One string-list control: a labelled textarea with its override badge and reset. */
function ListRow(props: {
  readonly id: string
  readonly label: string
  readonly hint: string
  readonly state: FieldState
  readonly copy: FieldCopy
  readonly disabled: boolean
  readonly onEdit: (text: string) => void
  readonly onReset: () => void
}): ReactNode {
  const message = props.state.invalid ? props.copy.invalid : props.hint
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <label htmlFor={props.id} style={{ fontSize: 13, fontWeight: 500, color: 'var(--dsw-alias-label-primary)' }}>
          {props.label}
        </label>
        {props.state.overridden ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Tag tone="neutral">{props.copy.overridden}</Tag>
            <button
              type="button"
              onClick={props.onReset}
              disabled={props.disabled}
              style={{ background: 'none', border: 'none', padding: 0, cursor: props.disabled ? 'default' : 'pointer', fontSize: 12, color: 'var(--dsw-alias-state-business-primary)' }}
            >
              {props.copy.reset}
            </button>
          </span>
        ) : null}
      </div>
      <textarea
        id={props.id}
        value={props.state.text}
        disabled={props.disabled}
        onChange={(event) => props.onEdit(event.target.value)}
        spellCheck={false}
        style={{
          minHeight: 96,
          resize: 'vertical',
          padding: '8px 10px',
          borderRadius: 8,
          border: '1px solid var(--dsw-alias-border-l1)',
          background: 'var(--dsw-alias-bg-layer-2)',
          color: 'var(--dsw-alias-label-primary)',
          fontFamily: 'var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace)',
          fontSize: 12.5,
          lineHeight: 1.5,
        }}
      />
      <p style={{ margin: 0, fontSize: 12, color: props.state.invalid ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-tertiary)' }}>
        {message}
      </p>
    </div>
  )
}

/** One boolean control: label and hint on the left, badge/reset/toggle on the right. */
function ToggleRow(props: {
  readonly id: string
  readonly label: string
  readonly hint: string
  readonly state: FieldState
  readonly copy: FieldCopy
  readonly disabled: boolean
  readonly onEdit: (text: string) => void
  readonly onReset: () => void
}): ReactNode {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        <label htmlFor={props.id} style={{ fontSize: 13, fontWeight: 500, color: 'var(--dsw-alias-label-primary)' }}>
          {props.label}
        </label>
        <span style={{ fontSize: 12, color: props.state.invalid ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-tertiary)' }}>
          {props.state.invalid ? props.copy.invalid : props.hint}
        </span>
      </span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        {props.state.overridden ? (
          <>
            <Tag tone="neutral">{props.copy.overridden}</Tag>
            <button
              type="button"
              onClick={props.onReset}
              disabled={props.disabled}
              style={{ background: 'none', border: 'none', padding: 0, cursor: props.disabled ? 'default' : 'pointer', fontSize: 12, color: 'var(--dsw-alias-state-business-primary)' }}
            >
              {props.copy.reset}
            </button>
          </>
        ) : null}
        <Switch
          checked={props.state.text === 'true'}
          onChange={(next) => props.onEdit(next ? 'true' : 'false')}
          label={props.label}
          disabled={props.disabled}
        />
      </span>
    </div>
  )
}

/**
 * Render the staged configuration form, or the one-liner for `summary`.
 * @param props - injected face, owner view, and the locale seat.
 * @returns the one-liner, or the form with its Save.
 */
export function AutomodeSettingsPage(props: AutomodeSettingsPageProps): ReactNode {
  const { t } = props
  const state = useSyncExternalStore(props.store.subscribe, props.store.getSnapshot)
  if (props.view === 'summary') return t('settings.summary')
  const copy: FieldCopy = {
    overridden: t('field.overridden'),
    reset: t('field.reset'),
    invalid: t('field.invalid'),
  }
  const disabled = !state.writable || state.saving
  const row = (
    id: string,
    label: string,
    hint: string,
    st: FieldState,
    onEdit: (text: string) => void,
    onReset: () => void,
    extra?: { readonly invalidLabel?: string; readonly numeric?: boolean },
  ): ReactNode => (
    <TextRow
      id={`automode-${id}`}
      label={label}
      hint={hint}
      invalidLabel={extra?.invalidLabel ?? copy.invalid}
      state={st}
      copy={copy}
      disabled={disabled}
      {...extra?.numeric === undefined ? {} : { numeric: extra.numeric }}
      onEdit={onEdit}
      onReset={onReset}
    />
  )
  const list = (
    id: string,
    label: string,
    hint: string,
    st: FieldState,
    onEdit: (text: string) => void,
    onReset: () => void,
  ): ReactNode => (
    <ListRow
      id={`automode-${id}`}
      label={label}
      hint={hint}
      state={st}
      copy={copy}
      disabled={disabled}
      onEdit={onEdit}
      onReset={onReset}
    />
  )
  const toggle = (
    id: string,
    label: string,
    hint: string,
    st: FieldState,
    onEdit: (text: string) => void,
    onReset: () => void,
  ): ReactNode => (
    <ToggleRow
      id={`automode-${id}`}
      label={label}
      hint={hint}
      state={st}
      copy={copy}
      disabled={disabled}
      onEdit={onEdit}
      onReset={onReset}
    />
  )
  return (
    <SettingsForm
      labels={{
        unavailable: t('settings.unavailable'),
        readOnly: t('settings.readOnly'),
        saveFailed: t('settings.saveFailed'),
        save: t('settings.save'),
        saving: t('settings.saving'),
      }}
      state={state}
      onSave={props.save}
      onDiscard={props.discard}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <GroupHeading>{t('section.classifier')}</GroupHeading>
        {row('fast-provider', t('field.fastProvider'), t('field.fastProvider.hint'), state.fastProvider, (text) => props.edit('classifierFastProvider', text), () => props.resetField('classifierFastProvider'))}
        {row('fast-model', t('field.fastModel'), t('field.fastModel.hint'), state.fastModel, (text) => props.edit('classifierFastModel', text), () => props.resetField('classifierFastModel'))}
        {row('deep-provider', t('field.deepProvider'), t('field.deepProvider.hint'), state.deepProvider, (text) => props.edit('classifierDeepProvider', text), () => props.resetField('classifierDeepProvider'))}
        {row('deep-model', t('field.deepModel'), t('field.deepModel.hint'), state.deepModel, (text) => props.edit('classifierDeepModel', text), () => props.resetField('classifierDeepModel'))}

        <GroupHeading>{t('section.backend')}</GroupHeading>
        {row('backend', t('field.backend'), t('field.backend.hint'), state.backend, (text) => props.edit('classifierBackend', text), () => props.resetField('classifierBackend'), { invalidLabel: t('field.backend.invalid') })}
        {row('timeout', t('field.timeout'), t('field.timeout.hint'), state.timeout, (text) => props.edit('classifierTimeoutMs', text), () => props.resetField('classifierTimeoutMs'), { invalidLabel: t('field.timeout.invalid'), numeric: true })}
        {row('guidance', t('field.guidance'), t('field.guidance.hint'), state.guidance, (text) => props.edit('classifierGuidance', text), () => props.resetField('classifierGuidance'))}
        {row('jev-api-key', t('field.jevApiKey'), t('field.jevApiKey.hint'), state.jevApiKey, (text) => props.edit('jevApiKey', text), () => props.resetField('jevApiKey'))}
        {row('jev-base-url', t('field.jevBaseUrl'), t('field.jevBaseUrl.hint'), state.jevBaseUrl, (text) => props.edit('jevBaseUrl', text), () => props.resetField('jevBaseUrl'))}
        {row('jev-model', t('field.jevModel'), t('field.jevModel.hint'), state.jevModel, (text) => props.edit('jevModel', text), () => props.resetField('jevModel'))}
        {row('jev-threshold', t('field.jevThreshold'), t('field.jevThreshold.hint'), state.jevThreshold, (text) => props.edit('jevAllowThreshold', text), () => props.resetField('jevAllowThreshold'), { invalidLabel: t('field.jevThreshold.invalid') })}

        <GroupHeading>{t('section.guards')}</GroupHeading>
        {toggle('self-kill-guard', t('field.selfKillGuard'), t('field.selfKillGuard.hint'), state.selfKillGuard, (text) => props.edit('selfKillGuard', text), () => props.resetField('selfKillGuard'))}
        {toggle('audit-session-events', t('field.auditSessionEvents'), t('field.auditSessionEvents.hint'), state.auditSessionEvents, (text) => props.edit('auditSessionEvents', text), () => props.resetField('auditSessionEvents'))}
        {list('deny-patterns', t('field.denyPatterns'), t('field.denyPatterns.hint'), state.denyPatterns, (text) => props.edit('denyPatterns', text), () => props.resetField('denyPatterns'))}
        {list('ask-patterns', t('field.askPatterns'), t('field.askPatterns.hint'), state.askPatterns, (text) => props.edit('askPatterns', text), () => props.resetField('askPatterns'))}
        {list('auto-approve-tools', t('field.autoApproveTools'), t('field.autoApproveTools.hint'), state.autoApproveTools, (text) => props.edit('autoApproveTools', text), () => props.resetField('autoApproveTools'))}
        {list('bash-command-prefixes', t('field.bashPrefixes'), t('field.bashPrefixes.hint'), state.bashCommandPrefixes, (text) => props.edit('bashCommandPrefixes', text), () => props.resetField('bashCommandPrefixes'))}
      </div>
    </SettingsForm>
  )
}

/**
 * The same form with the Settings dialog's section chrome (the dialog draws
 * the nav row itself; the Plugins page draws the plugin's title itself).
 * @param props - the page's props.
 * @returns the heading, intro, and the form.
 */
export function AutomodeSettingsSection(props: AutomodeSettingsPageProps): ReactNode {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 720 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }}>
          {props.t('settings.title')}
        </h2>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--dsw-alias-label-tertiary)' }}>
          {props.t('settings.intro')}
        </p>
      </div>
      <AutomodeSettingsPage {...props} />
    </div>
  )
}
