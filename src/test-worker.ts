import { Agent, callable } from 'agents'
import { RpcTarget } from 'cloudflare:workers'

import {
  rpcClient,
  rpcClientPlugin,
  rpcPlugin,
  rpcServer,
  rpcServerPlugin,
  rpcValue,
  type RpcNamespace,
} from './index'

interface InventoryRpcContext {
  actor?: string
  requestId?: string
  middlewareTrail?: string[]
}

export class RpcResult<T, E> {
  private constructor(
    public readonly status: 'ok' | 'error',
    public readonly value: T | undefined,
    public readonly error: E | undefined,
  ) {}

  public static ok<T, E = never>(value: T): RpcResult<T, E> {
    return new RpcResult<T, E>('ok', value, undefined)
  }

  public static err<T = never, E = unknown>(error: E): RpcResult<T, E> {
    return new RpcResult<T, E>('error', undefined, error)
  }

  public static isOk<T, E>(value: RpcResult<T, E>): value is RpcResult<T, E> & { status: 'ok'; value: T } {
    return value.status === 'ok'
  }

  public static isError<T, E>(value: RpcResult<T, E>): value is RpcResult<T, E> & { status: 'error'; error: E } {
    return value.status === 'error'
  }
}

export class Counter extends RpcTarget {
  #value: number

  constructor(value: number) {
    super()
    this.#value = value
  }

  increment(amount: number): number {
    this.#value += amount
    return this.#value
  }

  get value(): number {
    return this.#value
  }
}

interface CounterStubLike extends Disposable {
  increment(amount: number): Promise<number>
  readonly value: Promise<number>
  dup(): CounterStubLike
}

function hasValue(value: unknown): value is { value: unknown } {
  return typeof value === 'object' && value !== null && 'value' in value
}

function hasError(value: unknown): value is { error: unknown } {
  return typeof value === 'object' && value !== null && 'error' in value
}

function isRpcResult(value: unknown): value is RpcResult<unknown, unknown> {
  return value instanceof RpcResult
}

function encodeResult(value: RpcResult<unknown, unknown>): unknown {
  if (RpcResult.isOk(value)) {
    return { __rpcResultTag: true, status: 'ok' as const, value: value.value }
  }
  return { __rpcResultTag: true, status: 'error' as const, error: value.error }
}

function isEncodedResult(value: unknown): value is { __rpcResultTag: true; status: 'ok' | 'error'; value?: unknown; error?: unknown } {
  return typeof value === 'object' && value !== null && '__rpcResultTag' in value
}

function decodeResult(value: unknown): RpcResult<unknown, unknown> {
  if (!isEncodedResult(value)) {
    throw new Error('Invalid RpcResult payload')
  }
  if (value.status === 'ok') {
    if (!hasValue(value)) throw new Error('Missing ok value payload')
    return RpcResult.ok(value.value)
  }
  if (!hasError(value)) throw new Error('Missing error payload')
  return RpcResult.err(value.error)
}

function isPlainObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype
}

function mapPlainObjectValues(source: object, mapper: (value: unknown) => unknown): object {
  const clone = Object.create(Object.getPrototypeOf(source))

  for (const key of Reflect.ownKeys(source)) {
    const descriptor = Object.getOwnPropertyDescriptor(source, key)

    if (!descriptor) {
      continue
    }

    Object.defineProperty(
      clone,
      key,
      'value' in descriptor
        ? {
            ...descriptor,
            value: mapper(descriptor.value),
          }
        : descriptor,
    )
  }

  return clone
}

function encodeDeep(value: unknown): unknown {
  if (isRpcResult(value)) {
    return encodeResult(value)
  }
  if (Array.isArray(value)) {
    return value.map(encodeDeep)
  }
  if (isPlainObject(value)) {
    return mapPlainObjectValues(value, encodeDeep)
  }
  return value
}

function decodeDeep(value: unknown): unknown {
  if (isEncodedResult(value)) {
    return decodeResult(value)
  }
  if (Array.isArray(value)) {
    return value.map(decodeDeep)
  }
  if (isPlainObject(value)) {
    return mapPlainObjectValues(value, decodeDeep)
  }
  return value
}

export const resultRpcPlugin = rpcPlugin<InventoryAgentBase, InventoryRpcContext>({
  client: {
    onSuccess(value) {
      return decodeDeep(value)
    },
  },
  server: {
    onRequest({ method, context }) {
      if (method === 'currentContext') {
        return { args: [context] }
      }

      if (method === 'undefinedFromPlugin') {
        return { result: rpcValue(undefined) }
      }
    },
    onSuccess({ value }) {
      return encodeDeep(value)
    },
  },
})

export const requestIdPlugin = rpcClientPlugin<InventoryAgentBase, InventoryRpcContext>({
  onRequest({ context }) {
    if (context.requestId) {
      return
    }

    return {
      context: {
        ...context,
        requestId: 'req-generated-in-plugin',
      },
    }
  },
})

export const middlewareContextClientPlugin = rpcClientPlugin<InventoryAgentBase, InventoryRpcContext>({
  middleware({ context, next }) {
    return next({
      context: {
        ...context,
        middlewareTrail: [...(context.middlewareTrail ?? []), 'client'],
      },
    })
  },
})

export const middlewareTransformClientPlugin = rpcClientPlugin<InventoryAgentBase, InventoryRpcContext>({
  middleware({ method, next }) {
    if (method !== 'middlewareNumber') {
      return next()
    }

    return next().mapSuccess((value) => {
      if (typeof value !== 'number') {
        throw new Error('middlewareNumber should resolve to a number')
      }

      return value + 1
    })
  },
})

export const middlewareContextServerPlugin = rpcServerPlugin<InventoryAgentBase, InventoryRpcContext>({
  async middleware({ method, context, next }) {
    if (method !== 'middlewareContext') {
      return await next()
    }

    const patchedContext = {
      ...context,
      middlewareTrail: [...(context.middlewareTrail ?? []), 'server:middlewareContext'],
    }

    return await next({
      args: [patchedContext],
      context: patchedContext,
    })
  },
})

export class InventoryAgentBase extends Agent<Cloudflare.Env> {
  @callable({ description: 'Reserve inventory units' })
  async reserve(input: { sku: string; qty: number }): Promise<RpcResult<{ reserved: number }, { code: string }>> {
    if (input.qty > 3) {
      return RpcResult.err({ code: 'OUT_OF_STOCK' })
    }
    return RpcResult.ok({ reserved: input.qty })
  }

  @callable()
  async nestedReserve(input: { sku: string; qty: number }): Promise<{ result: RpcResult<{ reserved: number }, { code: string }> }> {
    if (input.qty > 3) {
      return { result: RpcResult.err({ code: 'OUT_OF_STOCK' }) }
    }
    return { result: RpcResult.ok({ reserved: input.qty }) }
  }

  @callable()
  async currentContext(context: InventoryRpcContext): Promise<InventoryRpcContext> {
    return context
  }

  @callable()
  async middlewareContext(context: InventoryRpcContext): Promise<InventoryRpcContext> {
    return context
  }

  @callable()
  async middlewareNumber(input: number): Promise<number> {
    return input
  }

  @callable()
  async counter(start: number): Promise<Counter> {
    return new Counter(start)
  }

  @callable()
  async nestedCounter(start: number): Promise<{ group: { counter: Counter } }> {
    return {
      group: {
        counter: new Counter(start),
      },
    }
  }

  @callable()
  async undefinedFromPlugin(): Promise<string> {
    throw new Error('undefinedFromPlugin should have been short-circuited by server plugin')
  }
}

export const InventoryAgent = rpcServer<typeof InventoryAgentBase, InventoryRpcContext>(InventoryAgentBase)
  .use(resultRpcPlugin)
  .use(middlewareContextServerPlugin)
  .build()

export class AccessorTrapAgentBase extends Agent<Cloudflare.Env> {
  get repository() {
    throw new Error('repository accessed before initialization')
  }

  @callable({ description: 'Ping from accessor trap agent' })
  async ping(): Promise<RpcResult<string, never>> {
    return RpcResult.ok('pong')
  }
}

export const AccessorTrapAgent = rpcServer(AccessorTrapAgentBase)
  .use(resultRpcPlugin)
  .build()

function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...init?.headers,
    },
  })
}

export default {
  async fetch(request: Request, env: Cloudflare.Env): Promise<Response> {
    const inventory = rpcClient.fromNamespace<InventoryAgentBase, InventoryRpcContext>(env.InventoryAgent as RpcNamespace)
      .use(requestIdPlugin)
      .use(resultRpcPlugin)
      .getByName('global', {
        context: {
          actor: 'worker@example.com',
        },
      })

    const inventoryWithMiddleware = rpcClient.fromNamespace<InventoryAgentBase, InventoryRpcContext>(env.InventoryAgent as RpcNamespace)
      .use(requestIdPlugin)
      .use(middlewareContextClientPlugin)
      .use(resultRpcPlugin)
      .getByName('global', {
        context: {
          actor: 'worker@example.com',
        },
      })

    const inventoryWithTransformMiddleware = rpcClient.fromNamespace<InventoryAgentBase, InventoryRpcContext>(env.InventoryAgent as RpcNamespace)
      .use(requestIdPlugin)
      .use(middlewareTransformClientPlugin)
      .use(resultRpcPlugin)
      .getByName('global', {
        context: {
          actor: 'worker@example.com',
        },
      })

    const url = new URL(request.url)

    if (url.pathname === '/reserve') {
      const qty = Number(url.searchParams.get('qty') ?? '0')
      const result = await inventory.reserve({ sku: 'coffee-beans', qty })

      if (RpcResult.isError(result)) {
        return json({ status: result.status, error: result.error }, { status: 409 })
      }

      return json({ status: result.status, value: result.value })
    }

    if (url.pathname === '/nested') {
      const qty = Number(url.searchParams.get('qty') ?? '0')
      const payload = await inventory.nestedReserve({ sku: 'coffee-beans', qty })
      return json({
        nestedStatus: payload.result.status,
        nestedValue: payload.result.value,
        nestedError: payload.result.error,
      })
    }

    if (url.pathname === '/context') {
      const context = await inventory.currentContext({})
      return json(context)
    }

    if (url.pathname === '/middleware-context') {
      const context = await inventoryWithMiddleware.middlewareContext({})
      return json(context)
    }

    if (url.pathname === '/middleware-transform') {
      const value = await inventoryWithTransformMiddleware.middlewareNumber(4)
      return json({ value })
    }

    if (url.pathname === '/pipelined-counter') {
      const start = Number(url.searchParams.get('start') ?? '0')
      const amount = Number(url.searchParams.get('amount') ?? '0')

      {
        using counter = inventory.counter(start)
        const value = await counter.increment(amount)
        return json({ value })
      }
    }

    if (url.pathname === '/nested-pipelined-counter') {
      const start = Number(url.searchParams.get('start') ?? '0')
      const amount = Number(url.searchParams.get('amount') ?? '0')

      {
        using nestedCounter = inventory.nestedCounter(start)
        const value = await nestedCounter.group.counter.increment(amount)
        return json({ value })
      }
    }

    if (url.pathname === '/dup-counter') {
      const start = Number(url.searchParams.get('start') ?? '0')
      const first = Number(url.searchParams.get('first') ?? '0')
      const second = Number(url.searchParams.get('second') ?? '0')

      {
        using counter = await inventory.counter(start) as unknown as CounterStubLike
        using duplicate = counter.dup()
        const afterFirst = await counter.increment(first)
        const afterSecond = await duplicate.increment(second)
        return json({ afterFirst, afterSecond })
      }
    }

    if (url.pathname === '/undefined-plugin') {
      const result = await inventory.undefinedFromPlugin()
      return new Response(result === undefined ? null : 'unexpected', {
        status: result === undefined ? 204 : 500,
      })
    }

    return new Response('not found', { status: 404 })
  },
}
