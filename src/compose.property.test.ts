import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { rpcClient, rpcServer, rpcServerPlugin } from './index'
import { contextArb } from './test-arbitraries'

describe('cloudflare-rpc composition properties', () => {
  it('server middleware propagates downstream context into later server hooks', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.string({ minLength: 1, maxLength: 8 }), { maxLength: 8 }), async (steps) => {
        class ExampleAgent {
          ping(): string {
            return 'pong'
          }
        }

        const Wrapped = steps.reduce(
          (builder, step) => builder.use(rpcServerPlugin<ExampleAgent, { trace: string[] }>({
            async middleware({ context, next }) {
              return await next({
                context: {
                  trace: [...context.trace, step],
                },
              })
            },
          })),
          rpcServer<typeof ExampleAgent, { trace: string[] }>(ExampleAgent)
            .use(rpcServerPlugin<ExampleAgent, { trace: string[] }>({
              onSuccess({ value, context }) {
                return {
                  value,
                  trace: context.trace,
                }
              },
            })),
        ).build()

        const client = rpcClient.fromStub<ExampleAgent, { trace: string[] }>(new Wrapped()).stub({
          context: { trace: [] },
        })

        await expect(client.ping()).resolves.toEqual({ value: 'pong', trace: steps })
      }),
    )
  })

  it('server middleware short-circuit returns undefined without invoking the native method and preserves finish context', async () => {
    await fc.assert(
      fc.asyncProperty(contextArb, async (context) => {
        let terminalCalls = 0
        let finishContext: typeof context | undefined = undefined
        let finishStatus: 'success' | 'error' | undefined = undefined

        class ExampleAgent {
          ping(): string {
            terminalCalls += 1
            return 'terminal'
          }
        }

        const Wrapped = rpcServer<typeof ExampleAgent, typeof context>(ExampleAgent)
          .use(rpcServerPlugin<ExampleAgent, typeof context>({
            async middleware() {
              return undefined
            },
            onFinish({ context: observedContext, status }) {
              finishContext = observedContext
              finishStatus = status
            },
          }))
          .build()

        const client = rpcClient.fromStub<ExampleAgent, typeof context>(new Wrapped()).stub({ context })

        await expect(client.ping()).resolves.toBe(undefined)
        expect(terminalCalls).toBe(0)
        expect(finishContext).toEqual(context)
        expect(finishStatus).toBe('success')
      }),
    )
  })
})
