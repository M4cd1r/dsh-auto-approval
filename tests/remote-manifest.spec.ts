import { describe, expect, it } from 'vitest'
import { remoteManifest } from '../src/remote-manifest.ts'
import { TYPERT_REMOTE } from '../src/client/remote.ts'

/** Structural view of a strict Typert codec as the 0.1.7 gateway consumes it. */
interface CodecLike {
  mode?: string
  typeSymbol?: string
  create?: () => { parse(value: unknown): unknown }
  schema?: unknown
}

function expectStrictCodec(codec: CodecLike): void {
  expect(codec.mode).toBe('strict')
  expect(typeof codec.typeSymbol).toBe('string')
  expect(codec.typeSymbol).not.toBe('')
  expect(typeof codec.create).toBe('function')
  const schema = codec.create?.()
  expect(schema).toBeTypeOf('object')
  expect(typeof (schema as { parse?: unknown }).parse).toBe('function')
  expect('schema' in codec).toBe(false)
}

describe('Typert strict codecs (DSH 0.1.7 create() contract)', () => {
  it('host manifest exposes create() on every parameter and result codec', () => {
    expect(remoteManifest.invocations.length).toBeGreaterThan(0)
    for (const descriptor of remoteManifest.invocations) {
      for (const parameter of descriptor.parameters) {
        expectStrictCodec(parameter.codec as CodecLike)
      }
      expectStrictCodec(descriptor.result as CodecLike)
    }
  })

  it('client remote contribution exposes create() on every parameter and result codec', () => {
    expect(TYPERT_REMOTE.descriptors.length).toBeGreaterThan(0)
    for (const descriptor of TYPERT_REMOTE.descriptors) {
      for (const parameter of descriptor.parameters) {
        expectStrictCodec(parameter.codec as CodecLike)
      }
      expectStrictCodec(descriptor.result as CodecLike)
    }
  })
})
