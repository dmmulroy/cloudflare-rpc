import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { rpcClient, rpcClientCall, rpcClientPlugin } from './index'
import { contextArb, reservedMethodNameArb } from './test-arbitraries'

describe('cloudflare-rpc client properties', () => {
  it('applies client success hooks in registration order', () => {
    fc.assert(
      fc.property(fc.array(fc.string({ maxLength: 6 }), { maxLength: 8 }), contextArb, (suffixes, context) => {
        const stub = {
          ping() {
            return 'base'
          },
        }

        const wrapped = suffixes.reduce(
          (client, suffix) => client.use(rpcClientPlugin<typeof stub, typeof context>({
            onSuccess(value) {
              if (typeof value !== 'string') {
                throw new Error('expected string value')
              }
              return `${value}${suffix}`
            },
          })),
          rpcClient.fromStub<typeof stub, typeof context>(stub),
        ).stub({ context })

        expect(wrapped.ping()).toBe(`base${suffixes.join('')}`)
      }),
    )
  })

  it('applies client error hooks in registration order', () => {
    fc.assert(
      fc.property(fc.array(fc.string({ maxLength: 6 }), { maxLength: 8 }), contextArb, (suffixes, context) => {
        const stub = {
          ping() {
            throw new Error('base')
          },
        }

        const wrapped = suffixes.reduce(
          (client, suffix) => client.use(rpcClientPlugin<typeof stub, typeof context>({
            onError(error) {
              if (!(error instanceof Error)) {
                throw new Error('expected Error')
              }
              return new Error(`${error.message}${suffix}`)
            },
          })),
          rpcClient.fromStub<typeof stub, typeof context>(stub),
        ).stub({ context })

        let caught: unknown = undefined
        try {
          wrapped.ping()
        } catch (error: unknown) {
          caught = error
        }

        expect(caught).toBeInstanceOf(Error)
        expect((caught as Error).message).toBe(`base${suffixes.join('')}`)
      }),
    )
  })

  it('runs each client finish hook exactly once with the final status', () => {
    fc.assert(
      fc.property(fc.array(fc.string({ maxLength: 6 }), { maxLength: 8 }), contextArb, fc.boolean(), (labels, context, shouldThrow) => {
        const seen: Array<{ label: string; status: 'success' | 'error' }> = []
        const stub = {
          ping() {
            if (shouldThrow) {
              throw new Error('boom')
            }
            return 'ok'
          },
        }

        const wrapped = labels.reduce(
          (client, label) => client.use(rpcClientPlugin<typeof stub, typeof context>({
            onFinish({ status }) {
              seen.push({ label, status })
            },
          })),
          rpcClient.fromStub<typeof stub, typeof context>(stub),
        ).stub({ context })

        if (shouldThrow) {
          expect(() => wrapped.ping()).toThrow('boom')
          expect(seen).toEqual(labels.map((label) => ({ label, status: 'error' as const })))
        } else {
          expect(wrapped.ping()).toBe('ok')
          expect(seen).toEqual(labels.map((label) => ({ label, status: 'success' as const })))
        }
      }),
    )
  })

  it('client middleware can short-circuit without invoking the native stub', () => {
    fc.assert(
      fc.property(fc.string(), contextArb, (shortCircuitValue, context) => {
        let nativeCalls = 0
        const stub = {
          ping() {
            nativeCalls += 1
            return 'native'
          },
        }

        const wrapped = rpcClient.fromStub<typeof stub, typeof context>(stub)
          .use(rpcClientPlugin<typeof stub, typeof context>({
            middleware({ context: middlewareContext }) {
              return rpcClientCall(shortCircuitValue, { context: middlewareContext })
            },
          }))
          .stub({ context })

        expect(wrapped.ping()).toBe(shortCircuitValue)
        expect(nativeCalls).toBe(0)
      }),
    )
  })

  it('reserved methods are passed through without wrapping and preserve binding', () => {
    fc.assert(
      fc.property(reservedMethodNameArb, fc.string(), (reservedMethodName, value) => {
        const calls: string[] = []
        const stub = {
          current: value,
          [reservedMethodName]() {
            calls.push(reservedMethodName)
            return this.current
          },
        }

        const wrapped = rpcClient.fromStub(stub).stub()
        const reservedMethod = Reflect.get(wrapped as object, reservedMethodName)

        expect(typeof reservedMethod).toBe('function')

        if (typeof reservedMethod !== 'function') {
          throw new Error('expected reserved method passthrough to be callable')
        }

        expect(Reflect.apply(reservedMethod, wrapped as object, [])).toBe(value)
        expect(calls).toEqual([reservedMethodName])
      }),
    )
  })
})
