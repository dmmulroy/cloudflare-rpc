# cloudflare-rpc

Typed helpers for Cloudflare native RPC, Durable Objects, and Agents.

## What is included

- explicit client entrypoints:
  - `rpcClient.fromNamespace(...)`
  - `rpcClient.fromStub(...)`
- type-safe server wrapping with `rpcServer(...)`
- lazy-aware client middleware and hooks that preserve RPC promise pipelining
- Cloudflare Vitest worker-pool integration tests

## Scripts

- `pnpm run cf-types` — regenerate `worker-configuration.d.ts`
- `pnpm run typecheck` — regenerate types and run TypeScript
- `pnpm run test` — regenerate types and run Vitest
- `pnpm run check` — regenerate types, typecheck, and run tests

## Development

This repo is self-contained and uses:

- `wrangler`
- `@cloudflare/vitest-pool-workers`
- `agents`
- `vitest`
- `typescript`
