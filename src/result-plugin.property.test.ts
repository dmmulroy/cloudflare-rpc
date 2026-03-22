import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { RpcResult, InventoryAgentBase, resultRpcPlugin } from './test-worker'

type DeepResultValue =
  | null
  | boolean
  | number
  | string
  | RpcResult<DeepResultValue, DeepResultValue>
  | DeepResultValue[]
  | {
      first?: DeepResultValue
      second?: DeepResultValue
      third?: DeepResultValue
    }

function omitUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  const entries = Object.entries(value).filter(([, entry]) => entry !== undefined)
  return Object.fromEntries(entries) as Partial<T>
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype
}

function normalizeDeep(value: unknown): unknown {
  if (value instanceof RpcResult) {
    if (RpcResult.isOk(value)) {
      return {
        __rpcResultTag: true,
        status: 'ok',
        value: normalizeDeep(value.value),
      }
    }

    return {
      __rpcResultTag: true,
      status: 'error',
      error: normalizeDeep(value.error),
    }
  }

  if (Array.isArray(value)) {
    return value.map(normalizeDeep)
  }

  if (isPlainObject(value)) {
    const normalized: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) {
      normalized[key] = normalizeDeep(entry)
    }
    return normalized
  }

  return value
}

function deepResultValueArb(maxDepth: number): fc.Arbitrary<DeepResultValue> {
  const leafArb: fc.Arbitrary<DeepResultValue> = fc.oneof(
    fc.constant(null),
    fc.boolean(),
    fc.integer(),
    fc.string(),
  )

  if (maxDepth <= 0) {
    return fc.oneof(
      leafArb,
      leafArb.map((leaf) => RpcResult.ok<DeepResultValue, DeepResultValue>(leaf)),
      leafArb.map((leaf) => RpcResult.err<DeepResultValue, DeepResultValue>(leaf)),
    )
  }

  const child = deepResultValueArb(maxDepth - 1)

  return fc.oneof(
    leafArb,
    fc.array(child, { maxLength: 3 }),
    fc.record({
      first: fc.option(child, { nil: undefined }),
      second: fc.option(child, { nil: undefined }),
      third: fc.option(child, { nil: undefined }),
    }).map((value) => omitUndefined(value) as DeepResultValue),
    leafArb.map((leaf) => RpcResult.ok<DeepResultValue, DeepResultValue>(leaf)),
    leafArb.map((leaf) => RpcResult.err<DeepResultValue, DeepResultValue>(leaf)),
  )
}

describe('resultRpcPlugin properties', () => {
  it('round-trips deeply nested RpcResult payloads through server/client success hooks', () => {
    fc.assert(
      fc.property(deepResultValueArb(3), (value) => {
        const serverOnSuccess = resultRpcPlugin.server?.onSuccess
        const clientOnSuccess = resultRpcPlugin.client?.onSuccess

        if (!serverOnSuccess || !clientOnSuccess) {
          throw new Error('expected resultRpcPlugin to provide both client and server onSuccess hooks')
        }

        const encoded = serverOnSuccess({
          instance: Object.create(InventoryAgentBase.prototype) as InventoryAgentBase,
          method: 'reserve',
          context: {},
          value,
        })

        const decoded = clientOnSuccess(encoded, {
          method: 'reserve',
          context: {},
        })

        expect(normalizeDeep(decoded)).toEqual(normalizeDeep(value))
      }),
    )
  })
})
