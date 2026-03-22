import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { rpcValue } from './plugin'
import { RESERVED_METHOD_NAMES } from './constants'
import { appendContextToArgs, extractContextFromArgs, resolveHookValue, shouldWrapMethod } from './utils'
import { contextArb, explicitTransformValueArb, nonReservedMethodNameArb, primitiveArgsArb } from './test-arbitraries'

describe('cloudflare-rpc utils properties', () => {
  it('appendContextToArgs and extractContextFromArgs round-trip primitive args and context', () => {
    fc.assert(
      fc.property(primitiveArgsArb, contextArb, (args, context) => {
        const appended = appendContextToArgs(args, context)
        const extracted = extractContextFromArgs(appended)

        expect(extracted.methodArgs).toEqual(args)
        expect(extracted.context).toEqual(Object.keys(context).length === 0 ? {} : context)
      }),
    )
  })

  it('resolveHookValue preserves current value only for implicit undefined', () => {
    fc.assert(
      fc.property(explicitTransformValueArb, explicitTransformValueArb, (currentValue, transformedValue) => {
        expect(resolveHookValue(currentValue, undefined)).toBe(currentValue)
        expect(resolveHookValue(currentValue, rpcValue(transformedValue))).toBe(transformedValue)

        if (transformedValue !== undefined) {
          expect(resolveHookValue(currentValue, transformedValue)).toBe(transformedValue)
        }
      }),
    )
  })

  it('shouldWrapMethod only wraps non-reserved public function names', () => {
    fc.assert(
      fc.property(nonReservedMethodNameArb, (methodName) => {
        expect(shouldWrapMethod(methodName, () => 'ok')).toBe(true)
        expect(shouldWrapMethod(methodName, 'not-a-function')).toBe(false)
        expect(shouldWrapMethod(`_${methodName}`, () => 'hidden')).toBe(false)
      }),
    )

    fc.assert(
      fc.property(fc.constantFrom(...RESERVED_METHOD_NAMES), (methodName) => {
        expect(shouldWrapMethod(methodName, () => 'reserved')).toBe(false)
      }),
    )
  })
})
