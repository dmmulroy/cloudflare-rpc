export const INTERNAL_MARKER = Symbol.for('mulroy/cloudflare-rpc/wrapped')
export const NO_SHORT_CIRCUIT = Symbol('mulroy/cloudflare-rpc/no-short-circuit')
export const RPC_CONTEXT_ENVELOPE_VERSION = 1

export const RESERVED_METHOD_NAMES = new Set<string>([
  'constructor',
  'connect',
  'dup',
  'fetch',
  'alarm',
  'webSocketMessage',
  'webSocketClose',
  'webSocketError',
])

export type ReservedMethodName =
  | 'constructor'
  | 'connect'
  | 'dup'
  | 'fetch'
  | 'alarm'
  | 'webSocketMessage'
  | 'webSocketClose'
  | 'webSocketError'
