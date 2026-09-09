# dsh-auto-approval

[English](README.md) | [中文](README.zh.md)

> ⚠️ **Deprecated — use [dsh-automode](https://github.com/Andy8647/dsh-automode) instead.**
>
> This plugin only hooks `tools/pre-execute`. DeepSeek Harness's own approval prompts (sandbox escalation in particular) are a separate channel, so they still went to the user — "AA on" never actually meant unattended. `dsh-automode` re-implements the same classifier as a **fourth permission preset** (full access + approval `never`, no prompts at all) and ships the host and browser halves in one package.
>
> The npm packages `dsh-auto-approval` and `dsh-client-ui-auto-approval` are deprecated in favour of `dsh-automode`.

Automated tool-call approval for DeepSeek Harness: an `auto` tier for the approval policy that classifies every tool call as **allow / deny** (fully autonomous — no human in the loop, uncertain calls are denied).

A monorepo of two packages:

| Package | Role |
|---|---|
| [`packages/dsh-auto-approval`](./packages/dsh-auto-approval) | **host half**: pre-execute classifier (L0 rules + L1 LLM, two-state allow/deny) |
| [`packages/dsh-client-ui-auto-approval`](./packages/dsh-client-ui-auto-approval) | **client half**: AA status chip beside the composer access-mode selector, fed by the host via a Typert remote |

## Demo

![auto-approval two-state decision demo](https://raw.githubusercontent.com/Andy8647/dsh-auto-approval/main/docs/demo.gif)

The **chip** next to the composer shows the run state (`AA on` / `AA off`); hover for cumulative stats, click for a dialog with the on/off switch, config summary and the recent-decisions table. The demo covers: file read/write and `ls` whitelisted and dispatched directly, a harmless command allowed by the L1 classifier, and dangerous commands rejected by deny rules / legacy-ask rules (now denying) / the self-kill guard.

## Install

Install both halves into the same profile with one command (published to npm, ships built artifacts — no build environment needed). The host package declares the client companion as a dependency, so the AA status chip arrives with it:

```sh
dsh plugin --profile web add dsh-auto-approval
```

For source-based installs (development / self-hosting), see the [host package README](./packages/dsh-auto-approval).

## Compatibility

Tracks the latest official DeepSeek Harness release. Currently verified against `@deepseek-ai/dsh` **0.1.2-rc.1** (install → boot → real tool-call decision, in a disposable `DSH_HOME`). Older releases are not supported: the harness moves fast and this plugin only follows the current one.

## Development

```sh
pnpm install          # @deepseek-ai/* deps are public on npm; no token needed
pnpm -r run build     # build both packages
pnpm -r run test      # host unit tests
```

## License

BSD-3-Clause
