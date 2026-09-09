/**
 * Hand-written Typert Remote contribution for the host
 * `dsh-auto-approval` service.
 *
 * The upstream build generates this artifact from the Host FaceModel
 * (`@deepseek-ai/dsh-typert-generator` → `typert.remote-client.js`); this
 * standalone repo hand-writes it because the remote is a small hand-curated
 * surface and the generator is a whole-workspace TypeScript analyzer.
 *
 * Two halves must stay in lockstep with the host service
 * (`dsh-auto-approval/src/remote.ts`):
 * - the wire schemas (hand-rolled strict parsers in `./schema.ts`) must parse
 *   exactly what `AutomodeStatusService` returns;
 * - the `TypertRemoteMap`/`TypertRemoteScopeMap` declaration merges type
 *   `ctx.remote.automodeStatus.*` on the client.
 *
 * The `agent` parameter is a Typert lookup (`TypertLookupMap['agent']` =
 * `TypertLookup<Agent, SessionId>`, registered by the core `agents` service),
 * so its wire field is `agentId` and the client passes a `SessionId`.
 */
import type {
  RemoteResult,
  TypertRemoteContribution,
  TypertRemoteNamespace,
} from '@deepseek-ai/dsh-typert-protocol'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  decisionListSchema, sessionIdSchema, statusSchema,
} from './schema.ts'
import type { AutomodeStatus, DecisionRecord } from './schema.ts'

export type { AutomodeStatus, DecisionRecord } from './schema.ts'

/** Agent lookup parameter shared by every remote method. */
const agentParameter = {
  name: 'agent',
  wire: 'agentId',
  source: 'lookup',
  lookup: 'agent',
  codec: {
    mode: 'strict',
    typeSymbol: '@deepseek-ai/dsh-session/types#SessionId',
    schema: sessionIdSchema,
  },
} as const

/**
 * The generated Host-for-Client contribution, mounted by the client half via
 * `ctx.remote.$mount(TYPERT_REMOTE)`.
 */
export const TYPERT_REMOTE: TypertRemoteContribution = {
  package: 'dsh-auto-approval',
  descriptors: [
    {
      id: 'dsh-auto-approval#automodeStatus/getStatus',
      service: 'automodeStatus',
      namespace: 'automodeStatus',
      method: 'getStatus',
      invocation: { kind: 'direct' },
      scope: { context: 'agent', wire: 'agentId' },
      parameters: [agentParameter],
      result: {
        mode: 'strict',
        typeSymbol: 'dsh-auto-approval#AutomodeStatus',
        schema: statusSchema,
      },
    },
    {
      id: 'dsh-auto-approval#automodeStatus/getHistory',
      service: 'automodeStatus',
      namespace: 'automodeStatus',
      method: 'getHistory',
      invocation: { kind: 'direct' },
      scope: { context: 'agent', wire: 'agentId' },
      parameters: [agentParameter],
      result: {
        mode: 'strict',
        typeSymbol: 'dsh-auto-approval#DecisionRecord[]',
        schema: decisionListSchema,
      },
    },
  ],
}

export default TYPERT_REMOTE

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteMap {
    'automodeStatus/getStatus': (agentId: SessionId) => Promise<RemoteResult<AutomodeStatus>>
    'automodeStatus/getHistory': (agentId: SessionId) => Promise<RemoteResult<DecisionRecord[]>>
  }
  interface TypertRemoteNamespaceMap {
    'automodeStatus': TypertRemoteNamespace<'automodeStatus'>
  }
  interface TypertRemoteScopeMap {
    'agent:automodeStatus/getStatus': () => Promise<RemoteResult<AutomodeStatus>>
    'agent:automodeStatus/getHistory': () => Promise<RemoteResult<DecisionRecord[]>>
  }
}
