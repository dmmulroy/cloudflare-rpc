import { RpcTarget } from 'cloudflare:workers'

import {
  rpcClient,
  rpcClientCall,
  rpcClientPlugin,
  rpcPlugin,
  rpcServer,
  rpcServerPlugin,
  type RpcNamespace,
} from './index'

interface ExampleContext {
  actor: string
}

class ExampleCounter extends RpcTarget {
  increment(amount: number): number {
    return amount
  }
}

class ExampleAgent {
  ping(): string {
    return 'pong'
  }

  nestedCounter(start: number): { group: { counter: ExampleCounter } } {
    return {
      group: {
        counter: new ExampleCounter(),
      },
    }
  }
}

const namespace = {} as RpcNamespace<ExampleAgent>
const stub = {} as ExampleAgent

const clientOnly = rpcClientPlugin<ExampleAgent, ExampleContext>({
  middleware({ next }) {
    return next().mapSuccess((value) => value)
  },
  onRequest({ context }) {
    return {
      context: {
        actor: context.actor,
      },
    }
  },
})

const clientShortCircuit = rpcClientPlugin<ExampleAgent, ExampleContext>({
  middleware({ context }) {
    return rpcClientCall('cached', { context })
  },
})

const serverOnly = rpcServerPlugin<ExampleAgent, ExampleContext>({
  async middleware({ next }) {
    return await next()
  },
  onRequest({ context }) {
    void context.actor
  },
})

const shared = rpcPlugin<ExampleAgent, ExampleContext>({
  client: {
    onSuccess(value, { context }) {
      void context.actor
      return value
    },
  },
  server: {
    onSuccess({ value, context }) {
      void context.actor
      return value
    },
  },
})

rpcClient.fromNamespace<ExampleAgent, ExampleContext>(namespace)
  .use(clientOnly)
  .use(shared)
  .getByName('name', { context: { actor: 'client' } })

rpcClient.fromStub<ExampleAgent, ExampleContext>(stub)
  .use(clientOnly)
  .use(clientShortCircuit)
  .use(shared)
  .stub({ context: { actor: 'client' } })

rpcClient.fromStub<ExampleAgent, ExampleContext>(stub)
  .stub({ context: { actor: 'client' } })
  .nestedCounter(1)
  .group
  .counter
  .increment(2)

rpcServer<typeof ExampleAgent, ExampleContext>(ExampleAgent)
  .use(serverOnly)
  .use(shared)
  .method('ping')
  .use(serverOnly)
  .done()
  .build()

// @ts-expect-error server-only plugins are not accepted by rpcClient.fromNamespace().use()
rpcClient.fromNamespace<ExampleAgent, ExampleContext>(namespace).use(serverOnly)

// @ts-expect-error client-only plugins are not accepted by rpcServer().use()
rpcServer<typeof ExampleAgent, ExampleContext>(ExampleAgent).use(clientOnly)

// @ts-expect-error context shape is checked on getByName()
rpcClient.fromNamespace<ExampleAgent, ExampleContext>(namespace).getByName('name', { context: { actorId: 'wrong' } })

// @ts-expect-error method names are checked on rpcServer().method()
rpcServer<typeof ExampleAgent, ExampleContext>(ExampleAgent).method('missing')
