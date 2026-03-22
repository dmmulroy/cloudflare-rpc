import { describe, expect, it } from 'vitest'
import { env } from 'cloudflare:workers'
import { SELF, runInDurableObject } from 'cloudflare:test'

import { AccessorTrapAgent, Counter, InventoryAgent, InventoryAgentBase, RpcResult, resultRpcPlugin } from './test-worker'
import { rpcClient, rpcClientCall, rpcClientPlugin, rpcServer, rpcServerPlugin } from './index'

describe('@mulroy/cloudflare-rpc', () => {
  it('preserves Agents callable metadata on wrapped methods', () => {
    const fakeAgent = Object.create(InventoryAgent.prototype) as {
      getCallableMethods(): Map<string, { description?: string }>
      _isCallable(method: string): boolean
    }

    expect(fakeAgent._isCallable('reserve')).toBe(true)
    expect(fakeAgent.getCallableMethods().get('reserve')).toEqual({
      description: 'Reserve inventory units',
    })
  })

  it('wraps Agents that have throwing getters on their prototype chain', () => {
    const fakeAgent = Object.create(AccessorTrapAgent.prototype) as {
      _isCallable(method: string): boolean
    }

    expect(fakeAgent._isCallable('ping')).toBe(true)
  })

  it('round-trips codec values from a wrapped Agent back to a Worker through Miniflare', async () => {
    const response = await SELF.fetch('https://example.com/reserve?qty=2')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      status: 'ok',
      value: { reserved: 2 },
    })
  })

  it('round-trips nested codec values from a wrapped Agent back to a Worker through Miniflare', async () => {
    const response = await SELF.fetch('https://example.com/nested?qty=4')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      nestedStatus: 'error',
      nestedValue: undefined,
      nestedError: { code: 'OUT_OF_STOCK' },
    })
  })

  it('returns error payloads from a wrapped Agent call made by the Worker', async () => {
    const response = await SELF.fetch('https://example.com/reserve?qty=4')

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      status: 'error',
      error: { code: 'OUT_OF_STOCK' },
    })
  })

  it('propagates client context to server hooks', async () => {
    const response = await SELF.fetch('https://example.com/context')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      actor: 'worker@example.com',
      requestId: 'req-generated-in-plugin',
    })
  })

  it('supports middleware patching on both client and server', async () => {
    const response = await SELF.fetch('https://example.com/middleware-context')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      actor: 'worker@example.com',
      requestId: 'req-generated-in-plugin',
      middlewareTrail: ['client', 'server:middlewareContext'],
    })
  })

  it('supports client middleware result transforms without breaking lazy rpc semantics', async () => {
    const response = await SELF.fetch('https://example.com/middleware-transform')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ value: 5 })
  })

  it('supports direct stub wrapping without going through the worker fetch path', async () => {
    const id = env.InventoryAgent.idFromName('direct-stub')
    const rawStub = env.InventoryAgent.get(id)

    const inventory = rpcClient.fromStub<InventoryAgentBase>(rawStub as unknown as InventoryAgentBase)
      .use(resultRpcPlugin)
      .stub()

    const result = await inventory.reserve({ sku: 'coffee-beans', qty: 2 })

    expect(RpcResult.isOk(result)).toBe(true)
    expect(result.value).toEqual({ reserved: 2 })
  })

  it('supports runInDurableObject() for direct Agent instance assertions', async () => {
    const id = env.InventoryAgent.idFromName('run-in-do')
    const stub = env.InventoryAgent.get(id)

    await runInDurableObject(stub, async (instance: InventoryAgentBase, state) => {
      expect(instance).toBeInstanceOf(InventoryAgentBase)
      expect(state.storage).toBeDefined()

      const result = await instance.reserve({ sku: 'coffee-beans', qty: 2 })
      expect(RpcResult.isOk(result)).toBe(true)
      expect(result.value).toEqual({ reserved: 2 })

      const counter = await instance.counter(2)
      expect(counter).toBeInstanceOf(Counter)
      expect(counter.increment(5)).toBe(7)
    })
  })

  it('preserves promise pipelining for returned RpcTarget instances', async () => {
    const response = await SELF.fetch('https://example.com/pipelined-counter?start=2&amount=5')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      value: 7,
    })
  })

  it('supports nested object-graph pipelining on the raw native stub', async () => {
    const id = env.InventoryAgent.idFromName('native-nested-pipelining')
    const rawStub = env.InventoryAgent.get(id)

    const value = await rawStub.nestedCounter(2).group.counter.increment(5)

    expect(value).toBe(7)
  })

  it('supports nested object-graph pipelining on a wrapped stub without plugins', async () => {
    const id = env.InventoryAgent.idFromName('wrapped-nested-pipelining-no-plugins')
    const rawStub = env.InventoryAgent.get(id)
    const inventory = rpcClient.fromStub(rawStub).stub()

    const value = await inventory.nestedCounter(2).group.counter.increment(5)

    expect(value).toBe(7)
  })

  it('supports nested object-graph pipelining on a wrapped stub with result plugin', async () => {
    const id = env.InventoryAgent.idFromName('wrapped-nested-pipelining-result-plugin')
    const rawStub = env.InventoryAgent.get(id)
    const inventory = rpcClient.fromStub(rawStub)
      .use(resultRpcPlugin)
      .stub()

    const nested = inventory.nestedCounter(2)
    expect(nested.group).toBeDefined()

    const awaitedGroup = await nested.group
    expect(awaitedGroup).toBeDefined()
    expect(awaitedGroup.counter).toBeDefined()

    const value = await nested.group.counter.increment(5)

    expect(value).toBe(7)
  })

  it('preserves nested object-graph pipelining for returned stubs', async () => {
    const response = await SELF.fetch('https://example.com/nested-pipelined-counter?start=2&amount=5')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      value: 7,
    })
  })

  it('forwards reserved dup() access on resolved RPC stubs', async () => {
    const response = await SELF.fetch('https://example.com/dup-counter?start=1&first=2&second=5')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      afterFirst: 3,
      afterSecond: 8,
    })
  })

  it('supports explicit undefined short-circuit results from plugins', async () => {
    const response = await SELF.fetch('https://example.com/undefined-plugin')

    expect(response.status).toBe(204)
    expect(await response.text()).toBe('')
  })

  it('rejects client middleware that calls next() multiple times', async () => {
    const stub = rpcClient.fromStub({
      ping() {
        return 'pong'
      },
    })
      .use(rpcClientPlugin({
        middleware({ next }) {
          next()
          return next()
        },
      }))
      .stub()

    expect(() => stub.ping()).toThrow('called next() multiple times')
  })

  it('allows client middleware to short-circuit through rpcClientCall()', () => {
    const stub = rpcClient.fromStub({
      ping() {
        return 'pong'
      },
    })
      .use(rpcClientPlugin({
        middleware({ context }) {
          return rpcClientCall('cached-pong', { context })
        },
      }))
      .stub()

    expect(stub.ping()).toBe('cached-pong')
  })

  it('rejects server middleware that calls next() multiple times', async () => {
    class PingAgent {
      ping(): string {
        return 'pong'
      }
    }

    const Wrapped = rpcServer(PingAgent)
      .use(rpcServerPlugin({
        async middleware({ next }) {
          await next()
          return await next()
        },
      }))
      .build()

    const instance = new Wrapped()

    await expect(instance.ping()).rejects.toThrow('called next() multiple times')
  })

  it('marks wrapped classes idempotently', () => {
    const Wrapped = rpcServer(InventoryAgentBase)
      .use(resultRpcPlugin)
      .build()

    expect(Wrapped).toBe(InventoryAgentBase)
  })
})
