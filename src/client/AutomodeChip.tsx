/**
 * Composer status chip for the automode runtime.
 *
 * The chip renders **only while the session runs under the `automode`
 * permission preset** — the preset is the switch, so there is no toggle here.
 * It reads the official `permissions` projection (the same value the dropdown
 * shows) and stays hidden for every other preset.
 *
 * State comes from the injected `getStatus` remote call: a token-colored dot
 * plus a short label, with cumulative counts in the hover Tooltip. Clicking
 * opens the official Modal with the armed config summary, cumulative counts,
 * and the recent decisions table (time, tool, stage, verdict, matched
 * pattern / rationale).
 *
 * Theming: every color resolves through `--dsw-alias-*` semantic tokens,
 * which `ui-theme` redefines under `body[data-ds-dark-theme]` — dark/light
 * switching is automatic. Official components (Pill / Tooltip / Modal) ride
 * the platform module table, so no CSS-module pipeline is needed; locally
 * composed parts (stat tiles, table, dot) use inline styles over the same
 * tokens.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Modal, Pill, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the ui-conversation SlotMap merge (the input.left seat + SessionStandardProps).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the `permissions` SessionProjectionMap merge.
import type {} from '@deepseek-ai/dsh-permission-presets'
import type { AutomodeChipInjected } from './index.ts'
import type { AutomodeStatus, DecisionRecord } from './remote.ts'

/** Full chip component props: the runtime standard kit + owner share + injected face + the locale `t` seat. */
export type AutomodeChipProps = PropsRuntime<'conversation.input.left'> & InjectFace<AutomodeChipInjected> & PropsLocale<'automode'>

/** Translate function of this chip's locale namespace. */
type T = TranslateNS<'automode'>

/** The preset whose selection turns this plugin on (matches the bundle patch table key). */
const AUTOMODE_PRESET = 'automode'

/** Poll cadence while the chip stays mounted (no event forwarding for third-party remotes). */
const POLL_MS = 2000

/** One-time acknowledgment flag: Automode shares full access with no approval prompts. */
const ACK_KEY = 'dsh-auto-approval:acknowledged'

type ChipState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'status'; readonly status: AutomodeStatus }

/* ------------------------------------------------------------------ */
/* Official design tokens (alias layer: theme switching is automatic). */
/* ------------------------------------------------------------------ */

const SUCCESS = 'var(--dsw-alias-state-success-primary)'
const ERROR = 'var(--dsw-alias-state-error-primary)'
const LABEL_PRIMARY = 'var(--dsw-alias-label-primary)'
const LABEL_SECONDARY = 'var(--dsw-alias-label-secondary)'
const LABEL_CAPTION = 'var(--dsw-alias-label-caption)'
const BORDER_L1 = 'var(--dsw-alias-border-l1)'
const BORDER_L2 = 'var(--dsw-alias-border-l2)'
const BG_LAYER_2 = 'var(--dsw-alias-bg-layer-2)'
const BG_LAYER_3 = 'var(--dsw-alias-bg-layer-3)'
const MONO_FONT = 'var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace)'

/**
 * Width/space overrides for the official Modal: the figma dialog is
 * min(380px, 100%) wide (truncates the decision table) and the official body
 * carries a 20px top margin (extra whitespace under the title). We keep every
 * official behavior (mask, blur, Escape, portal, aria) and only adjust chrome
 * via classes injected below — no !important on layout-critical properties
 * beyond these two overrides.
 */
const DIALOG_WIDTH_CSS = `
.aa-modal-wide { width: min(660px, 100%) !important; }
.aa-modal-flush > *:last-child { margin-top: 0 !important; }
`

/* ------------------------------------------------------------------ */
/* Text helpers                                                        */
/* ------------------------------------------------------------------ */

/** Cumulative counts as a compact "✓ n · ✗ n" line for the tooltip. */
function countLine(status: AutomodeStatus, t: T): string {
  return t('chip.counts', { approved: status.approvals, denied: status.totalDenials })
}

/** From "provider/model" take the model segment (keeps the summary short). */
function shortModel(classifier: string): string {
  const slash = classifier.lastIndexOf('/')
  return slash >= 0 ? classifier.slice(slash + 1) : classifier
}

/* ------------------------------------------------------------------ */
/* Decision table pieces                                               */
/* ------------------------------------------------------------------ */

const CELL: React.CSSProperties = {
  padding: '8px 10px',
  fontSize: 12,
  lineHeight: '18px',
  textAlign: 'left',
  verticalAlign: 'top',
}

const HEADER_CELL: React.CSSProperties = {
  ...CELL,
  fontWeight: 600,
  color: LABEL_SECONDARY,
  borderBottom: `1px solid ${BORDER_L2}`,
  // Sticky header stays readable while the table body scrolls; the fill must
  // be opaque or scrolled rows would bleed through.
  position: 'sticky',
  top: 0,
  background: BG_LAYER_2,
}

/** Verdict label: colored by the official state-token pair (allow/deny only). */
function VerdictBadge({ decision, t }: { decision: DecisionRecord['decision']; t: T }): ReactNode {
  const color = decision === 'allow' ? SUCCESS : ERROR
  return (
    <span style={{ color, fontWeight: 600, whiteSpace: 'nowrap' }}>
      {t(decision === 'allow' ? 'verdict.allow' : 'verdict.deny')}
    </span>
  )
}

function DecisionRow({ record, t }: { readonly record: DecisionRecord; readonly t: T }): ReactNode {
  const detail = record.pattern !== undefined ? `pattern /${record.pattern}/` : (record.detail ?? '')
  const time = new Date(record.time)
  const timeText = Number.isNaN(time.getTime())
    ? record.time
    : time.toLocaleTimeString(undefined, { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
  return (
    <tr style={{ borderTop: `1px solid ${BORDER_L1}` }}>
      <td style={{ ...CELL, whiteSpace: 'nowrap', color: LABEL_CAPTION, fontFamily: MONO_FONT }}>{timeText}</td>
      <td style={{ ...CELL, whiteSpace: 'nowrap', color: LABEL_PRIMARY, fontFamily: MONO_FONT }}>{record.tool}</td>
      <td style={{
        ...CELL, maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: LABEL_SECONDARY,
      }} title={record.stage}>
        {record.stage}
      </td>
      <td style={CELL}><VerdictBadge decision={record.decision} t={t} /></td>
      <td style={{
        ...CELL, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: LABEL_SECONDARY,
      }} title={detail}>
        {detail}
      </td>
    </tr>
  )
}

/* ------------------------------------------------------------------ */
/* Stat tile                                                           */
/* ------------------------------------------------------------------ */

/** Stat tile: raised surface (layer-3) on the layer-2 dialog card. */
function StatTile({ label, value, color }: { label: string; value: number; color: string }): ReactNode {
  return (
    <div style={{
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: 2,
      padding: '10px 8px',
      borderRadius: 12,
      border: `1px solid ${BORDER_L1}`,
      background: BG_LAYER_3,
    }}>
      <span style={{ fontSize: 20, lineHeight: '24px', fontWeight: 600, color }}>{value}</span>
      <span style={{ fontSize: 11, lineHeight: '16px', color: LABEL_CAPTION }}>
        {label}
      </span>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Config summary (dialog)                                             */
/* ------------------------------------------------------------------ */

/** Formatted armed-config rows: plain-language labels, no internal jargon. */
function ConfigSummary({ status, t }: { status: AutomodeStatus; t: T }): ReactNode {
  const rows: Array<[string, string]> = [
    [t('config.safetyRules'), `${status.denyPatterns + status.askPatterns}`],
    [t('config.reviewModel'), status.classifier === 'disabled' ? t('config.off') : shortModel(status.classifier)],
    [t('config.trustedTools'), `${status.autoApproveTools}`],
  ]
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      {rows.map(([label, value]) => (
        <div key={label} style={{ display: 'flex', gap: 10, fontSize: 12, lineHeight: '18px' }}>
          <span style={{ width: 92, flexShrink: 0, color: LABEL_CAPTION }}>{label}</span>
          <span style={{ color: LABEL_SECONDARY }}>{value}</span>
        </div>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Dialog body                                                         */
/* ------------------------------------------------------------------ */

function DialogContent({
  status, history, t,
}: {
  status: AutomodeStatus
  history: readonly DecisionRecord[]
  t: T
}): ReactNode {
  return (
    <>
      <ConfigSummary status={status} t={t} />

      {/* Cumulative counts */}
      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        <StatTile label={t('stat.approved')} value={status.approvals} color={SUCCESS} />
        <StatTile label={t('stat.denied')} value={status.totalDenials} color={ERROR} />
      </div>

      {/* Recent decisions */}
      <div style={{ marginTop: 16, fontSize: 13, lineHeight: '20px', fontWeight: 600, color: LABEL_PRIMARY }}>
        {t('history.title')}
        {history.length > 0 && (
          <span style={{ fontSize: 11, fontWeight: 400, color: LABEL_CAPTION, marginLeft: 6 }}>
            {t('history.count', { count: history.length })}
          </span>
        )}
      </div>
      {history.length === 0
        ? (
          <div style={{ padding: '12px 0', fontSize: 12, lineHeight: '18px', color: LABEL_SECONDARY }}>
            {t('history.empty')}
          </div>
        )
        : (
          // The official dialog is min(380px, 100%) wide; the table scrolls
          // vertically inside the card rather than stretching it.
          <div style={{ marginTop: 6, maxHeight: '38vh', overflowY: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={HEADER_CELL}>{t('table.time')}</th>
                  <th style={HEADER_CELL}>{t('table.tool')}</th>
                  <th style={HEADER_CELL}>{t('table.stage')}</th>
                  <th style={HEADER_CELL}>{t('table.verdict')}</th>
                  <th style={HEADER_CELL}>{t('table.detail')}</th>
                </tr>
              </thead>
              <tbody>
                {history.map((record, index) => <DecisionRow key={index} record={record} t={t} />)}
              </tbody>
            </table>
          </div>
        )}
    </>
  )
}

/* ------------------------------------------------------------------ */
/* Chip                                                                */
/* ------------------------------------------------------------------ */

/**
 * The status pill. It renders only under the automode preset and owns its
 * polling; a failed remote read renders an error-colored label with the error
 * in the tooltip rather than breaking the composer.
 */
export function AutomodeChip({ getStatus, getHistory, useProjection, t }: AutomodeChipProps) {
  const permissions = useProjection('permissions')
  const active = permissions !== undefined && permissions.currentValue === AUTOMODE_PRESET
  const [state, setState] = useState<ChipState>({ kind: 'loading' })
  const [dialogOpen, setDialogOpen] = useState(false)
  const [ackOpen, setAckOpen] = useState(false)
  const [history, setHistory] = useState<readonly DecisionRecord[]>([])
  const alive = useRef(true)

  // First use of Automode in this browser: explain the trade-off once. The
  // official "Enable Full access?" gate is keyed to `danger-full-access` and
  // never fires for a custom preset, so this preset carries its own notice.
  useEffect(() => {
    if (!active) return
    let seen = '1'
    try {
      seen = localStorage.getItem(ACK_KEY) ?? ''
    } catch {
      return // storage unavailable: don't nag on every render
    }
    if (seen !== '1') setAckOpen(true)
  }, [active])

  const acknowledge = useCallback((): void => {
    try {
      localStorage.setItem(ACK_KEY, '1')
    } catch {
      // Storage unavailable: the notice shows again next mount; harmless.
    }
    setAckOpen(false)
  }, [])

  const pollStatus = useCallback((): void => {
    void getStatus().then(
      (result) => {
        if (!alive.current) return
        if (result.ok) setState({ kind: 'status', status: result.value })
        else setState({ kind: 'error', message: result.error.message })
      },
      (reason: unknown) => {
        if (!alive.current) return
        setState({ kind: 'error', message: reason instanceof Error ? reason.message : String(reason) })
      },
    )
  }, [getStatus])

  useEffect(() => {
    alive.current = true
    if (!active) return () => { alive.current = false }
    pollStatus()
    const timer = setInterval(pollStatus, POLL_MS)
    return () => {
      alive.current = false
      clearInterval(timer)
    }
  }, [active, pollStatus])

  // Refresh the decision history while the dialog is open (2s cadence, same as status).
  useEffect(() => {
    if (!dialogOpen) return
    let cancelled = false
    const refresh = (): void => {
      void getHistory().then(
        (result) => {
          if (cancelled) return
          if (result.ok) setHistory(result.value)
        },
        () => { /* history is best-effort; the status line already surfaces failures */ },
      )
    }
    refresh()
    const timer = setInterval(refresh, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [dialogOpen, getHistory])

  if (!active) return null

  let dot = SUCCESS
  let label = t('chip.label')
  let title = t('chip.label')
  if (state.kind === 'loading') {
    dot = LABEL_CAPTION
    title = t('chip.loading')
  } else if (state.kind === 'error') {
    dot = ERROR
    title = t('chip.error', { message: state.message })
  } else {
    title = countLine(state.status, t)
  }

  return (
    <>
      {/* One-time global width override for the official Modal dialog. */}
      <style>{DIALOG_WIDTH_CSS}</style>
      {/*
       * The Tooltip anchor must be a host element: Tooltip attaches its ref
       * via cloneElement, and the official Pill is a function component
       * without forwardRef — wrapping it in this span keeps the tooltip
       * working while Pill provides the official capsule visuals and hover.
       */}
      <Tooltip label={title} side="top" delayMs={300}>
        <span style={{ display: 'inline-flex' }}>
          <Pill onClick={() => setDialogOpen(true)} aria-label={title} aria-haspopup="dialog">
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: dot, flexShrink: 0 }} aria-hidden />
            {label}
          </Pill>
        </span>
      </Tooltip>
      <Modal
        open={ackOpen}
        onClose={acknowledge}
        title={t('ack.title')}
        closeLabel={t('dialog.close')}
      >
        <div style={{ fontSize: 13, lineHeight: '20px', color: LABEL_SECONDARY }}>{t('ack.body')}</div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
          <Pill onClick={acknowledge}>{t('ack.confirm')}</Pill>
        </div>
      </Modal>
      <Modal
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        title={t('dialog.title')}
        closeLabel={t('dialog.close')}
        className="aa-modal-wide"
        contentClassName="aa-modal-flush"
      >
        {state.kind === 'status'
          ? <DialogContent status={state.status} history={history} t={t} />
          : (
            <div style={{ fontSize: 12, lineHeight: '18px', color: LABEL_SECONDARY }}>
              {state.kind === 'loading'
                ? t('dialog.loading')
                : t('dialog.unavailable', { message: state.message })}
            </div>
          )}
      </Modal>
    </>
  )
}
