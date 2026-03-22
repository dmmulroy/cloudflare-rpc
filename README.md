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

A Durable Object can return raw storage values while the client layer turns them into something nicer for an admin UI.

```ts
import { rpcClient, rpcClientPlugin, rpcServer } from 'cloudflare-rpc'

class LinkCatalogObject {
  getClickCount(slug: string): number {
    if (slug === 'docs') {
      return 4200
    }

    return 0
  }
}

const clickStatsPlugin = rpcClientPlugin<LinkCatalogObject>({
  onSuccess(value, { method }) {
    if (method === 'getClickCount' && typeof value === 'number') {
      return {
        count: value,
        label: `${value.toLocaleString()} clicks`,
      }
    }

    return value
  },
})

export const LinkCatalogRpc = rpcServer(LinkCatalogObject).build()

const links = rpcClient
  .fromNamespace<LinkCatalogObject>(env.LinkCatalogObject)
  .use(clickStatsPlugin)
  .getByName('global')

const stats = await links.getClickCount('docs')
// {
//   count: 4200,
//   label: '4,200 clicks'
// }
```

The Durable Object stays simple and returns a raw number.
The client plugin adapts that result for the place it is being used.

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
interface AdminContext {
  actorEmail: string
  requestId: string
}

const links = rpcClient
  .fromNamespace<LinkCatalogObject, AdminContext>(env.LinkCatalogObject)
  .getByName('global', {
    context: {
      actorEmail: 'ops@example.com',
      requestId: crypto.randomUUID(),
    },
  })

const link = await links.getLink('docs')
```

This is a good fit for Worker handlers that fetch a named Durable Object on demand.

### From an existing stub

Use `rpcClient.fromStub(...)` when some other part of the application already resolved the raw native stub.

```ts
const id = env.LinkCatalogObject.idFromName('global')
const rawStub = env.LinkCatalogObject.get(id)

const links = rpcClient
  .fromStub<LinkCatalogObject, AdminContext>(rawStub)
  .stub({
    context: {
      actorEmail: 'ops@example.com',
      requestId: crypto.randomUUID(),
    },
  })
```

This is useful inside helper functions or middleware where you already have the native stub in hand.

### Returned RPC targets stay typed

If a method returns a `RpcTarget`, the client reflects that without manual casts.

```ts
import { RpcTarget } from 'cloudflare:workers'

class LinkEditor extends RpcTarget {
  setDestination(destination: string): { destination: string } {
    return { destination }
  }
}

class LinkCatalogObject {
  editor(slug: string): LinkEditor {
    return new LinkEditor()
  }
}

const updated = await links
  .editor('docs')
  .setDestination('https://developers.cloudflare.com/durable-objects/')
```

That means helper objects can stay first-class instead of being flattened into a single giant Durable Object interface.

## Server API

Wrap a class with `rpcServer(...)` to apply server-side middleware and hooks.

```ts
interface AdminContext {
  actorEmail: string
  requestId: string
}

class LinkCatalogObject {
  createLink(input: { slug: string; destination: string }) {
    return input
  }

  deleteLink(slug: string) {
    return { slug, deleted: true }
  }

  health() {
    return { ok: true }
  }
}

const requireAccessPlugin = rpcServerPlugin<LinkCatalogObject, AdminContext>({
  onRequest({ context }) {
    if (!context.actorEmail.endsWith('@example.com')) {
      throw new Error('forbidden')
    }
  },
})

const auditPlugin = rpcServerPlugin<LinkCatalogObject, AdminContext>({
  async middleware({ method, context, next }) {
    const result = await next()
    console.log('rpc audit', {
      method,
      actorEmail: context.actorEmail,
      requestId: context.requestId,
    })
    return result
  },
})

export const LinkCatalogRpc = rpcServer<typeof LinkCatalogObject, AdminContext>(LinkCatalogObject)
  .use(requireAccessPlugin)
  .method('createLink')
  .use(auditPlugin)
  .done()
  .method('deleteLink')
  .use(auditPlugin)
  .done()
  .build()
```

### Per-method configuration is typed

The `.method(...)` builder only accepts valid public method names, which makes it practical to add targeted policies around high-risk methods like deletes, writes, or billing operations.

### Agents metadata is preserved

If you wrap an `agents` `Agent` class with `@callable()` methods, the wrapper preserves the callable metadata.

## Middleware and hooks

You can attach client-only, server-only, or shared plugins.

### Client plugin

A practical client plugin can attach request context and emit latency metrics without changing the Durable Object itself.

```ts
import { rpcClientPlugin } from 'cloudflare-rpc'

const requestContextPlugin = rpcClientPlugin<LinkCatalogObject, AdminContext>({
  onRequest({ context }) {
    return {
      context: {
        ...context,
        requestId: context.requestId || crypto.randomUUID(),
      },
    }
  },

  middleware({ method, next }) {
    const startedAt = Date.now()

    return next().onFinish(({ context, status }) => {
      console.log('rpc client', {
        method,
        actorEmail: context.actorEmail,
        requestId: context.requestId,
        status,
        durationMs: Date.now() - startedAt,
      })
    })
  },
})
```

### Server plugin

A server plugin is a good place for authorization, policy checks, or request normalization.

```ts
import { rpcServerPlugin } from 'cloudflare-rpc'

const requireAdminPlugin = rpcServerPlugin<LinkCatalogObject, AdminContext>({
  onRequest({ context }) {
    if (!context.actorEmail.endsWith('@example.com')) {
      throw new Error('forbidden')
    }
  },
})
```

### Shared plugin

A shared plugin can keep client/server transforms in one place when a transport shape needs to be encoded on the server and decoded on the client.

```ts
import { rpcPlugin } from 'cloudflare-rpc'

const timestampPlugin = rpcPlugin<LinkCatalogObject, AdminContext>({
  client: {
    onSuccess(value, { method }) {
      if (
        method === 'getLink'
        && typeof value === 'object'
        && value !== null
        && 'updatedAt' in value
        && typeof value.updatedAt === 'string'
      ) {
        return {
          ...value,
          updatedAt: new Date(value.updatedAt),
        }
      }

      return value
    },
  },
  server: {
    onSuccess({ value, method }) {
      if (
        method === 'getLink'
        && typeof value === 'object'
        && value !== null
        && 'updatedAt' in value
        && value.updatedAt instanceof Date
      ) {
        return {
          ...value,
          updatedAt: value.updatedAt.toISOString(),
        }
      }

      return value
    },
  },
})
```

### Applying plugins

```ts
const links = rpcClient
  .fromNamespace<LinkCatalogObject, AdminContext>(env.LinkCatalogObject)
  .use(requestContextPlugin)
  .use(timestampPlugin)
  .getByName('global', {
    context: {
      actorEmail: 'ops@example.com',
      requestId: crypto.randomUUID(),
    },
  })

export const LinkCatalogRpc = rpcServer<typeof LinkCatalogObject, AdminContext>(LinkCatalogObject)
  .use(requireAdminPlugin)
  .use(timestampPlugin)
  .build()
```

## Nested RPC object graphs

Returned nested RPC graphs are typed and supported.

```ts
import { RpcTarget } from 'cloudflare:workers'

class DailyCounter extends RpcTarget {
  increment(amount: number): number {
    return amount
  }
}

class AnalyticsObject {
  analytics(slug: string): { today: { counter: DailyCounter } } {
    return {
      today: {
        counter: new DailyCounter(),
      },
    }
  }
}

const analytics = rpcClient
  .fromStub<AnalyticsObject>(stub)
  .stub()

await analytics
  .analytics('docs')
  .today
  .counter
  .increment(1)
```

This matters when a Durable Object wants to return focused helpers or stateful RPC targets instead of forcing every operation through a single flat class surface.

## Explicit short-circuit values

Use `rpcClientCall(...)` to short-circuit a client middleware chain.

A realistic case is a cached health check or metadata endpoint.

```ts
import { rpcClientCall, rpcClientPlugin } from 'cloudflare-rpc'

const healthCache = new Map<string, { ok: boolean; checkedAt: string }>()

const cachedHealthPlugin = rpcClientPlugin<LinkCatalogObject, AdminContext>({
  middleware({ method, context, next }) {
    if (method !== 'health') {
      return next()
    }

    const cached = healthCache.get(context.actorEmail)
    if (cached) {
      return rpcClientCall(cached, { context })
    }

    return next()
  },
})
```

Use `rpcValue(...)` when a hook needs to explicitly return a value that might otherwise be treated as "no change", such as `undefined`.

```ts
import { rpcServerPlugin, rpcValue } from 'cloudflare-rpc'

const optionalDraftPlugin = rpcServerPlugin<LinkCatalogObject>({
  onRequest({ method, args }) {
    if (method === 'findDraftBySlug' && args[0] === 'missing') {
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
