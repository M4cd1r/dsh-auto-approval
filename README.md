# dsh-auto-approval

[English](README.md) | [中文](README.zh.md)

A **fourth permission preset** for DeepSeek Harness: pick **Automode** in the composer's permission dropdown and the session runs on full access with an LLM classifier as the only gate before every tool call. No approval prompts — the classifier answers for you.

The permission model stays 3 + 1: the three official sandbox levels, plus one auto tier. Selecting any other preset turns the plugin off; there is no second switch.

> **0.2.0 is a rewrite of the 0.1.x line.** The on/off switch became a permission preset: install, pick **Automode**, done. Upgrading? See [Upgrading from 0.1.x](#upgrading-from-01x).

## Demo

![Automode: a multi-step task runs unattended, then a denied call shows up in the decision table](docs/demo.gif)

The recording: pick **Automode**, send one prompt (create a directory, write a file, read it back, then run `echo danger_test`). The agent runs the file steps unattended — the classifier allows them (`L1-deep` / `whitelist`) — and the final command is blocked by a hard rule (`L0-deny`). The chip's dialog shows both verdicts and the cumulative counts.

## How it works

```text
model wants a tool call
        │
        ├─ preset ≠ automode ──────────────► untouched (official behavior)
        │
        └─ preset = automode
                 │
                 ├─ L0 rules (hard deny) ───► deny   (rm -rf /, curl | sh, self-kill …)
                 ├─ trusted tools / bash prefixes ──► allow
                 └─ L1 classifier ──────────► allow | deny   (fail-closed: timeout/parse/no-model → deny)
```

- **L0** — regex deny rules, self-kill guard, trusted-tool and bash-prefix allowlists. Deterministic, no model call.
- **L1** — the latest real user message plus the bare tool call go to a classifier. Two backends: **`llm`** (default) runs a two-stage prompt on a chat model (fast single-token filter → deep CoT check when flagged); **`jev`** sends one HTTP request to TypeSafe's System One and gets back typed probabilities — the verdict is a threshold comparison, no text parsing. Tool output is never shown to the classifier on either backend, so injected content cannot talk it into an allow.
- **Fail-closed** — a timeout, a parse failure, or a missing model denies the call.

The preset writes the same knobs as `danger-full-access` (full access + approval `never`), so nothing else asks the user either. What distinguishes the two entries is the plugin's gate — and the official preset service keeps the last selected name, so the dropdown shows which one you picked.

## Install

```sh
dsh plugin --profile web add dsh-auto-approval
```

> **Just published a new version?** pnpm 11 refuses versions younger than 24 hours (`minimumReleaseAge`, a supply-chain default), so `add dsh-auto-approval` resolves the *previous* release for the first day. Install the exact version (`dsh plugin --profile web add dsh-auto-approval@0.2.0`) or add the package to the profile's `pnpm-workspace.yaml`:
>
> ```yaml
> minimumReleaseAgeExclude:
>   - dsh-auto-approval
> ```

Then pick **Automode** in the permission dropdown next to the composer (or `/permission automode`). The first time you do so in a browser, a one-time notice explains the trade-off (the official "Enable Full access?" gate is keyed to `danger-full-access` and never fires for a custom preset). The `Auto` chip then appears beside the preset selector with cumulative allow/deny counts and a click-through decision table.

Source install: clone the repo, `pnpm install && pnpm run build`, then `dsh plugin --profile web add link:/<path>`.

## Upgrading from 0.1.x

0.2.0 keeps the package name, the `auto-approval:` settings section and every config key, so an upgrade needs no config changes. What changed:

| | 0.1.x | 0.2.0 |
|---|---|---|
| Switch | plugin setting `enabled` + a UI switch | the **Automode** permission preset (no second switch) |
| Packages | `dsh-auto-approval` + `dsh-client-ui-auto-approval` | `dsh-auto-approval` (host + browser halves in one package) |
| Sandbox | whatever preset was active; DSH's own escalation prompt still reached the user | full access + approval `never`; nothing prompts |
| L1 unconfigured | allowed everything (a rubber stamp) | denies everything outside the allowlists |

```sh
# 1. drop the old companion package (its browser half now ships in the main package)
dsh plugin --profile web remove dsh-client-ui-auto-approval

# 2. upgrade
pnpm --dir "$DSH_HOME/profiles/web" up dsh-auto-approval

# 3. restart dsh, then pick Automode in the permission dropdown
```

If your `settings.yaml` has no classifier configured (`classifierFastProvider` / `classifierFastModel`), automode now fails closed — configure one, or only trusted tools and allowlisted commands will run.

## Configuration

Configuration is the plugin's profile entry — edit it through the GUI or by hand in `$DSH_HOME/profiles/web/cordis.patch.yml`. The browser half ships the form itself, in both places a DSH 0.1.7 configuration page can live:

- **Settings → Automode** — a first-class section in the Settings dialog's nav; present on every deployment.
- **Plugins (sidebar) → dsh-auto-approval → Configure** — the canonical row page on the official Plugins page, when that page is composed.

Since DSH 0.1.7 the fields are volatile, so edits apply live to the running session (no remount); the form stages every field and writes once on Save, and an invalid live update is rejected and keeps the last good config (a `classifierFastProvider` without its model is refused by the Host, and the form reports the failed save instead of dropping the drafts). A legacy `$DSH_HOME/settings.yaml` is imported by DSH once and renamed:

```yaml
- id: auto-approval
  name: dsh-auto-approval
  config:
    denyPatterns:
      - 'rm\s+(-[a-z]*[fr][a-z]*\s+)*/\s*$'
      - 'curl\s+[^|]*\x7c\s*(ba)?sh'
    autoApproveTools: [read, write, edit, glob, grep, ls]
    bashCommandPrefixes: [ls, pwd, git status, git diff, pnpm test]
    classifierFastProvider: deepseek-official
    classifierFastModel: deepseek-v4-flash
    classifierDeepProvider: deepseek-official
    classifierDeepModel: deepseek-v4-pro
    classifierGuidance: 'Prefer allowing read-only and test commands.'
```

Every key is optional. `denyPatterns` / `autoApproveTools` / `bashCommandPrefixes` **replace** the defaults wholesale (YAML arrays do not merge), so restate the values you want to keep.

Without a classifier there is no L1, and automode fails closed: only trusted tools and allowlisted commands run, everything else is denied. That is deliberate — a session with no classifier is not a safety net, and silently allowing everything would make the gate a rubber stamp.

### Jev backend (TypeSafe System One)

`classifierBackend: jev` replaces the two-stage LLM prompt with a single typed-probability call to [Jev](https://docs.typesafe.ai/api). Jev does not generate text: one request returns calibrated probabilities for five questions asked over the same frame (latest user message + tool name + arguments), and the verdict is a threshold comparison in code — the whole text-parsing chain (VERDICT lines, truncation finishes, token budgets) disappears. One round trip, ~300 ms.

```sh
export TYPESAFE_API_KEY=<your key>   # recommended; see the warning below
```

```yaml
auto-approval:
  classifierBackend: jev
  # optional:
  jevModel: jev-latest        # default; the response carries the actual version, logged for traceability
  jevAllowThreshold: 0.9      # default; must be in the open interval (0, 1)
```

`classifierTimeoutMs` is reused as the per-request timeout — no new key. Do **not** combine `classifierBackend: jev` with `classifierFast*`/`classifierDeep*` routes: ambiguous configuration throws at load (fail-loud). The API key resolves from `jevApiKey` first, then `TYPESAFE_API_KEY`. **Warning: `jevApiKey` in the profile patch is stored in plaintext — prefer the environment variable.** The key never appears in logs, audit events, or deny reasons.

**One gate, four witnesses.** Of the five questions asked in the single request, only `clearly_safe` decides: `noul ≥ jevAllowThreshold` → allow, otherwise deny. `destructive`, `exfiltration`, `beyond_scope` and `impact` are **recorded, not enforced** — their useful thresholds have to be measured on your own real sessions (classifier thresholds do not transfer across datasets), so read a few dozen real decisions from the log's signal distributions before promoting any of them to a gate. Every Jev decision writes a file-log line with all five signal values, `usage.input_tokens`, and the actual model version that answered.

**Rate limits and the no-retry trade-off.** jev-1.13 allows 1200 requests/min and 250k tokens/s; output tokens are free, input is billed ($0.042/MTok at the time of writing). The gate never retries: a 429/529 (or any other failure) denies the call instead of adding tail latency to your tool pipeline. If you hit limits, the failure mode is "automode denies and tells you", never "automode hangs".

## Permissions and data

| Surface | What this plugin does |
|---|---|
| Reads | Tool-call arguments under review; the session's `autoApprovalIntent` projection (only to find the latest real user message as classifier intent) |
| Writes | `$DSH_HOME/logs/auto-approval.log` — a local JSON-lines audit file, best-effort; a write failure only logs a warning |
| Network | Only when L1 is configured. `llm` backend: the user message + tool call go to that LLM provider. `jev` backend (off by default): the **latest real user message** (truncated to 4000 chars), the **tool name**, and the **arguments JSON** (truncated to 8000 chars) go to `https://api.typesafe.ai/v1/systemone`. **Tool output is never sent** on either backend — that is the injection defense, not a coincidence |
| Executes | Nothing. No subprocess, no shell, no file mutation outside the audit log |
| Intercepts | `tools/pre-execute` (prepended) plus a monotonic `ctx.tools.guard()` deny guard — both gated on the session's preset |
| Failure bounds | L1 timeout / parse failure / missing model → **deny**; invalid config throws at load (fail-loud); configuration comes from the profile entry, and an invalid live update keeps the last good config |

## Compatibility

Tracks the latest official DeepSeek Harness release. Verified against `@deepseek-ai/dsh` **0.1.7-rc.1** (install → boot → real tool-call decision in a disposable `DSH_HOME`). Older releases (0.1.5 and below) are not supported.

The bundle patch restates the official preset table, so a base release that adds a preset needs this file updated too. Note that your own profile patch is a later layer: if it re-states the `permission` row, it must include the `automode` preset itself (later layers win over this package's bundle patch), and `defaultPreset` stays user-owned.

## Development

```sh
pnpm install
pnpm run typecheck
pnpm run test
pnpm run build     # lib/index.js (host) + lib/client.js (browser)
```

## License

BSD-3-Clause
