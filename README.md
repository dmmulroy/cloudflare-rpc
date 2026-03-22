# cloudflare-rpc

Typed helpers for Cloudflare native RPC, Durable Objects, and Agents.

`cloudflare-rpc` wraps Cloudflare's native RPC model instead of re-implementing it.
It gives you:

- explicit client entrypoints
- typed server wrapping
- client and server middleware/hooks
- lazy-aware client transforms that preserve promise pipelining
- support for returned `RpcTarget` values and nested RPC object graphs
- real Cloudflare runtime tests with `@cloudflare/vitest-pool-workers`

## Install

This repo is currently set up as a standalone private project.

```sh
git clone git@github.com:dmmulroy/cloudflare-rpc.git
cd cloudflare-rpc
pnpm install
```

## Quick Start

```ts
import { RpcTarget } from 'cloudflare:workers'
import { rpcClient, rpcServer } from 'cloudflare-rpc'

class Counter extends RpcTarget {
  #value: number

  constructor(value: number) {
    super()
    this.#value = value
  }

  increment(amount: number): number {
    this.#value += amount
    return this.#value
  }
}

class InventoryAgent {
  ping(): string {
    return 'pong'
  }

  counter(start: number): Counter {
    return new Counter(start)
  }
}

export const InventoryRpc = rpcServer(InventoryAgent).build()

const inventory = rpcClient
  .fromNamespace<InventoryAgent>(env.InventoryAgent)
  .getByName('global')

const pong = await inventory.ping()
const value = await inventory.counter(2).increment(5)
```

The important part is that this stays lazy and pipelined:

```ts
await inventory.counter(2).increment(5)
```

The client wrapper preserves Cloudflare's native RPC behavior instead of forcing early `await`s.

## Contents

- [Why this exists](#why-this-exists)
- [Client API](#client-api)
- [Server API](#server-api)
- [Middleware and hooks](#middleware-and-hooks)
- [Nested RPC object graphs](#nested-rpc-object-graphs)
- [Explicit short-circuit values](#explicit-short-circuit-values)
- [Type utilities](#type-utilities)
- [Testing](#testing)
- [Development](#development)

## Why this exists

Cloudflare RPC is already good, but the raw surface can get awkward when you want to add:

- request/response transforms
- context propagation
- shared client/server plugins
- typed per-method server configuration
- stronger derived client types for returned RPC stubs

This package tries to stay small and close to native behavior while smoothing those edges.

## Client API

### From a namespace

Use `rpcClient.fromNamespace(...)` when you have a Durable Object namespace binding.

```ts
const inventory = rpcClient
  .fromNamespace<InventoryAgent, { actor: string }>(env.InventoryAgent)
  .getByName('global', {
    context: { actor: 'dashboard' },
  })

const pong = await inventory.ping()
```

### From an existing stub

Use `rpcClient.fromStub(...)` when you already resolved the raw native stub elsewhere.

```ts
const id = env.InventoryAgent.idFromName('global')
const rawStub = env.InventoryAgent.get(id)

const inventory = rpcClient
  .fromStub<InventoryAgent>(rawStub)
  .stub()
```

### Returned RPC targets stay typed

If a method returns a `RpcTarget`, the client type reflects that:

```ts
const value = await inventory.counter(1).increment(2)
```

No manual cast is needed to get the nested stub surface.

## Server API

Wrap a class with `rpcServer(...)` to apply middleware and hooks.

```ts
class ExampleAgent {
  ping(): string {
    return 'pong'
  }
}

const Wrapped = rpcServer(ExampleAgent).build()
```

### Per-method configuration is typed

The `.method(...)` builder only accepts valid public method names.

```ts
const Wrapped = rpcServer(ExampleAgent)
  .method('ping')
  .done()
  .build()
```

### Agents metadata is preserved

If you wrap an `agents` `Agent` class with `@callable()` methods, the wrapper preserves the callable metadata.

## Middleware and hooks

You can attach client-only, server-only, or shared plugins.

### Client plugin

```ts
import { rpcClientPlugin } from 'cloudflare-rpc'

const clientPlugin = rpcClientPlugin<InventoryAgent, { actor: string }>({
  onRequest({ context }) {
    return {
      context: {
        actor: context.actor,
      },
    }
  },

  middleware({ next }) {
    return next().mapSuccess((value) => value)
  },
})
```

### Server plugin

```ts
import { rpcServerPlugin } from 'cloudflare-rpc'

const serverPlugin = rpcServerPlugin<InventoryAgent, { actor: string }>({
  async middleware({ next }) {
    return await next()
  },
})
```

### Shared plugin

```ts
import { rpcPlugin } from 'cloudflare-rpc'

const sharedPlugin = rpcPlugin<InventoryAgent, { actor: string }>({
  client: {
    onSuccess(value) {
      return value
    },
  },
  server: {
    onSuccess({ value }) {
      return value
    },
  },
})
```

### Applying plugins

```ts
const inventory = rpcClient
  .fromNamespace<InventoryAgent, { actor: string }>(env.InventoryAgent)
  .use(clientPlugin)
  .use(sharedPlugin)
  .getByName('global', {
    context: { actor: 'dashboard' },
  })

const Wrapped = rpcServer<
  typeof ExampleAgent,
  { actor: string }
>(ExampleAgent)
  .use(serverPlugin)
  .use(sharedPlugin)
  .build()
```

## Nested RPC object graphs

Returned nested RPC graphs are typed and supported.

```ts
import { RpcTarget } from 'cloudflare:workers'

class Counter extends RpcTarget {
  increment(amount: number): number {
    return amount
  }
}

class ExampleAgent {
  nestedCounter(start: number): { group: { counter: Counter } } {
    return {
      group: {
        counter: new Counter(),
      },
    }
  }
}

const client = rpcClient
  .fromStub<ExampleAgent>(stub)
  .stub()

await client
  .nestedCounter(1)
  .group
  .counter
  .increment(2)
```

This matters because it keeps Cloudflare's property access and method pipelining behavior intact across nested returned graphs.

## Explicit short-circuit values

Use `rpcClientCall(...)` to short-circuit a client middleware chain.

```ts
import { rpcClientCall, rpcClientPlugin } from 'cloudflare-rpc'

const cachedPlugin = rpcClientPlugin<InventoryAgent, { actor: string }>({
  middleware({ context }) {
    return rpcClientCall('cached', { context })
  },
})
```

Use `rpcValue(...)` when a hook needs to explicitly return a value that might otherwise be treated as "no change", such as `undefined`.

```ts
import { rpcServerPlugin, rpcValue } from 'cloudflare-rpc'

const plugin = rpcServerPlugin<InventoryAgent>({
  onRequest({ method }) {
    if (method === 'optionalValue') {
      return {
        result: rpcValue(undefined),
      }
    }
  },
})
```

## Type utilities

Useful exported types include:

- `RpcClientOf<T>`
- `RpcResultOf<T>`
- `RpcProvider<T>`
- `RpcStubify<T>`
- `RpcSerializable<T>`
- `RpcMethodOrProperty<T>`

These are mainly helpful when you want to talk about the client-visible shape of returned RPC graphs in your own types.

## Testing

This repo uses real Cloudflare runtime integration locally:

- `@cloudflare/vitest-pool-workers`
- `SELF.fetch(...)`
- real Durable Object bindings in `wrangler.jsonc`
- direct Durable Object tests with `runInDurableObject(...)`
- property-based tests with `fast-check`

Scripts:

- `pnpm run cf-types` — regenerate `worker-configuration.d.ts`
- `pnpm run typecheck` — regenerate types and run TypeScript
- `pnpm run test` — regenerate types and run Vitest
- `pnpm run check` — regenerate types, typecheck, and run tests

## Development

The project is self-contained and uses:

- `wrangler`
- `@cloudflare/vitest-pool-workers`
- `agents`
- `fast-check`
- `vitest`
- `typescript`

If you change the Worker shape or bindings, rerun:

```sh
pnpm run cf-types
```
