import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { rpcServer, rpcServerPlugin } from './index'
import { InventoryAgentBase } from './test-worker'

describe('cloudflare-rpc server properties', () => {
  it('wrapping is idempotent for arbitrary plugin counts', () => {
    fc.assert(
      fc.property(fc.array(fc.string({ maxLength: 6 }), { maxLength: 8 }), (suffixes) => {
        class ExampleAgent {
          ping(): string {
            return 'pong'
          }
        }

        const builder = suffixes.reduce(
          (currentBuilder, suffix) => currentBuilder.use(rpcServerPlugin<ExampleAgent>({
            onSuccess({ value }) {
              if (typeof value !== 'string') {
                throw new Error('expected string')
              }
              return `${value}${suffix}`
            },
          })),
          rpcServer(ExampleAgent),
        )

        const WrappedOnce = builder.build()
        const WrappedTwice = rpcServer(WrappedOnce).build()

        expect(WrappedTwice).toBe(WrappedOnce)
      }),
    )
  })

  it('preserves callable metadata on Agent-style wrapped classes across repeated wrapping', () => {
    fc.assert(
      fc.property(fc.array(fc.string({ maxLength: 6 }), { maxLength: 8 }), (suffixes) => {
        const Wrapped = suffixes.reduce(
          (currentBuilder) => currentBuilder.use(rpcServerPlugin<InventoryAgentBase>({
            onSuccess({ value }) {
              return value
            },
          })),
          rpcServer(InventoryAgentBase),
        ).build()

        const WrappedAgain = rpcServer(Wrapped).build()
        const fakeAgent = Object.create(WrappedAgain.prototype) as {
          getCallableMethods(): Map<string, { description?: string }>
          _isCallable(method: string): boolean
        }

        expect(fakeAgent._isCallable('reserve')).toBe(true)
        expect(fakeAgent.getCallableMethods().get('reserve')).toEqual({
          description: 'Reserve inventory units',
        })
      }),
    )
  })

  it('server onSuccess hooks apply in registration order after wrapping', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.string({ maxLength: 6 }), { maxLength: 8 }), async (suffixes) => {
        class ExampleAgent {
          async ping(): Promise<string> {
            return 'pong'
          }
        }

        const Wrapped = suffixes.reduce(
          (currentBuilder, suffix) => currentBuilder.use(rpcServerPlugin<ExampleAgent>({
            onSuccess({ value }) {
              if (typeof value !== 'string') {
                throw new Error('expected string')
              }
              return `${value}${suffix}`
            },
          })),
          rpcServer(ExampleAgent),
        ).build()

        const instance = new Wrapped()
        await expect(instance.ping()).resolves.toBe(`pong${suffixes.join('')}`)
      }),
    )
  })
})
