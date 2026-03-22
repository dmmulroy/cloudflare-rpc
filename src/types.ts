import type { CallableMetadata } from 'agents'
import type { RpcStub as CloudflareRpcStub, RpcTarget } from 'cloudflare:workers'

export type MethodKey = string | symbol

export interface WrappedMarkerCarrier {
  [key: symbol]: boolean | undefined
}

export interface CallableMethodsCarrier {
  getCallableMethods(): Map<string, CallableMetadata>
}

export interface CallableCarrier {
  _isCallable(method: string): boolean
}

export interface SuppressedAccessor {
  prototype: object
  propertyName: string
  descriptor: PropertyDescriptor
}

export interface RpcContextEnvelope<TContext extends object = object> {
  __mulroyCloudflareRpcContext: true
  version: 1
  context: TContext
}

export interface ExplicitRpcValue<T = unknown> {
  __mulroyCloudflareRpcExplicitValue: true
  value: T
}

export interface Constructor<TInstance = object> {
  new (...args: Array<never>): TInstance
}

export interface DurableObjectIdLike {
  toString(): string
}

export interface RpcNamespace<_TStub extends object = object> {
  get(id: unknown, options?: unknown): object
  idFromName?(name: string): DurableObjectIdLike
  idFromString?(id: string): DurableObjectIdLike
  newUniqueId?(options?: unknown): DurableObjectIdLike
}

type RpcBaseType =
  | void
  | undefined
  | null
  | boolean
  | number
  | bigint
  | string
  | ArrayBuffer
  | DataView
  | Date
  | Error
  | RegExp
  | ReadableStream<Uint8Array>
  | WritableStream<Uint8Array>
  | Request
  | Response
  | Headers
  | Int8Array
  | Uint8Array
  | Uint8ClampedArray
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | Float32Array
  | Float64Array
  | BigInt64Array
  | BigUint64Array

/**
 * Values that Cloudflare can transport as live RPC stubs.
 */
export type RpcStubable = RpcTarget | ((...args: Array<unknown>) => unknown)

/**
 * Recursive approximation of Cloudflare RPC-serializable values.
 */
export type RpcSerializable<T> =
  | RpcBaseType
  | Map<T extends Map<infer U, unknown> ? RpcSerializable<U> : never, T extends Map<unknown, infer U> ? RpcSerializable<U> : never>
  | Set<T extends Set<infer U> ? RpcSerializable<U> : never>
  | ReadonlyArray<T extends ReadonlyArray<infer U> ? RpcSerializable<U> : never>
  | {
      [K in keyof T]: K extends number | string ? RpcSerializable<T[K]> : never
    }
  | CloudflareRpcStub<RpcStubable>
  | RpcStubable

/**
 * Maps a server-side value shape to the client-visible RPC stub shape.
 */
export type RpcStubify<T> =
  T extends RpcStubable ? CloudflareRpcStub<T>
    : T extends Map<infer K, infer V> ? Map<RpcStubify<K>, RpcStubify<V>>
      : T extends Set<infer V> ? Set<RpcStubify<V>>
        : T extends Array<infer V> ? Array<RpcStubify<V>>
          : T extends ReadonlyArray<infer V> ? ReadonlyArray<RpcStubify<V>>
            : T extends RpcBaseType ? T
              : T extends { [key: string | number]: unknown } ? { [K in keyof T]: RpcStubify<T[K]> }
                : T

type RpcUnstubify<T> =
  T extends CloudflareRpcStub<infer V> ? V
    : T extends Map<infer K, infer V> ? Map<RpcUnstubify<K>, RpcUnstubify<V>>
      : T extends Set<infer V> ? Set<RpcUnstubify<V>>
        : T extends Array<infer V> ? Array<RpcUnstubify<V>>
          : T extends ReadonlyArray<infer V> ? ReadonlyArray<RpcUnstubify<V>>
            : T extends RpcBaseType ? T
              : T extends { [key: string | number]: unknown } ? { [K in keyof T]: RpcUnstubify<T[K]> }
                : T

type RpcUnstubifyAll<TArgs extends ReadonlyArray<unknown>> = {
  [I in keyof TArgs]: RpcUnstubify<TArgs[I]>
}

type RpcMaybeDisposable<T> = T extends object ? Disposable : unknown

type RpcMaybeProvider<T> = T extends object ? RpcProvider<T> : unknown

/**
 * Result type returned by invoking an RPC method or reading an RPC property.
 */
export type RpcResultOf<T> =
  T extends RpcStubable ? Promise<CloudflareRpcStub<T>> & RpcProvider<T>
    : T extends RpcSerializable<T> ? Promise<RpcStubify<T> & RpcMaybeDisposable<T>> & RpcMaybeProvider<T>
      : never

/**
 * Client-side callable/property view for a single member of an RPC-exposed type.
 */
export type RpcMethodOrProperty<V> =
  V extends (...args: infer P) => infer R
    ? (...args: RpcUnstubifyAll<P>) => RpcResultOf<Awaited<R>>
    : RpcResultOf<Awaited<V>>

type RpcMaybeCallableProvider<T> = T extends (...args: Array<unknown>) => unknown ? RpcMethodOrProperty<T> : unknown

/**
 * Lazy, pipelinable client-side view over an RPC object graph.
 */
export type RpcProvider<T extends object, Reserved extends string = never> = RpcMaybeCallableProvider<T> & Pick<{
  [K in keyof T]: RpcMethodOrProperty<T[K]>
}, Exclude<keyof T, Reserved | symbol | 'dup' | keyof Disposable>>

/**
 * Public client type for a server-side RPC class or returned RPC object.
 */
export type RpcClientOf<T extends object> = RpcProvider<T>

export interface RpcClientMiddlewareInput<TContext extends object = object> {
  method: string
  args: unknown[]
  context: TContext
  next: (patch?: {
    args?: unknown[]
    context?: TContext
  }) => RpcClientCall<TContext>
}

export interface RpcServerMiddlewareInput<TInstance extends object = object, TContext extends object = object> {
  instance: TInstance
  method: string
  args: unknown[]
  context: TContext
  next: (patch?: {
    args?: unknown[]
    context?: TContext
  }) => Promise<unknown>
}

export interface RpcClientCall<TContext extends object = object> {
  readonly value: unknown
  readonly context: TContext
  readonly invokedNative: boolean
  mapSuccess(transform: (value: unknown, context: TContext) => unknown): RpcClientCall<TContext>
  mapError(transform: (error: unknown, context: TContext) => unknown): RpcClientCall<TContext>
  onFinish(listener: (input: { context: TContext; status: 'success' | 'error' }) => void): RpcClientCall<TContext>
}

export interface RpcClientPluginHooks<_TStub extends object = object, TContext extends object = object> {
  middleware?: (input: RpcClientMiddlewareInput<TContext>) => RpcClientCall<TContext>

  onRequest?: (input: {
    method: string
    args: unknown[]
    context: TContext
  }) => void | {
    args?: unknown[]
    context?: TContext
    result?: unknown | ExplicitRpcValue<unknown>
  }

  onSuccess?: (value: unknown, input: {
    method: string
    context: TContext
  }) => unknown | ExplicitRpcValue<unknown>

  onError?: (error: unknown, input: {
    method: string
    context: TContext
  }) => unknown | ExplicitRpcValue<unknown>

  onFinish?: (input: {
    method: string
    context: TContext
    status: 'success' | 'error'
  }) => void
}

export interface RpcServerPluginHooks<TInstance extends object = object, TContext extends object = object> {
  middleware?: (input: RpcServerMiddlewareInput<TInstance, TContext>) => unknown | Promise<unknown>

  onRequest?: (input: {
    instance: TInstance
    method: string
    args: unknown[]
    context: TContext
  }) => void | {
    args?: unknown[]
    context?: TContext
    result?: unknown | ExplicitRpcValue<unknown>
  }

  onSuccess?: (input: {
    instance: TInstance
    method: string
    context: TContext
    value: unknown
  }) => unknown | ExplicitRpcValue<unknown>

  onError?: (input: {
    instance: TInstance
    method: string
    context: TContext
    error: unknown
  }) => unknown | ExplicitRpcValue<unknown>

  onFinish?: (input: {
    instance: TInstance
    method: string
    context: TContext
    status: 'success' | 'error'
  }) => void
}

export interface RpcClientPlugin<TStub extends object = object, TContext extends object = object> {
  client: RpcClientPluginHooks<TStub, TContext>
}

export interface RpcServerPlugin<TInstance extends object = object, TContext extends object = object> {
  server: RpcServerPluginHooks<TInstance, TContext>
}

export interface RpcPluginShape<TShared extends object = object, TContext extends object = object> {
  client?: RpcClientPluginHooks<TShared, TContext>
  server?: RpcServerPluginHooks<TShared, TContext>
}

export type ClientUsablePlugin<TStub extends object, TContext extends object> = RpcClientPlugin<TStub, TContext> &
  Partial<RpcServerPlugin<TStub, TContext>>

export type ServerUsablePlugin<TInstance extends object, TContext extends object> = RpcServerPlugin<TInstance, TContext> &
  Partial<RpcClientPlugin<TInstance, TContext>>

export type RuntimeClientHooks<TContext extends object> = RpcClientPluginHooks<object, TContext>
export type RuntimeServerHooks<TContext extends object> = RpcServerPluginHooks<object, TContext>

export interface RpcState<TContext extends object> {
  args: unknown[]
  context: TContext
}

export interface ClientMiddlewareOutcome<TContext extends object> {
  call: RpcClientCall<TContext>
}

export interface ServerMiddlewareOutcome<TContext extends object> {
  value: unknown
  context: TContext
}

export type PublicMethodNames<TInstance extends object> = Exclude<{
  [K in keyof TInstance]: K extends string
    ? TInstance[K] extends (...args: Array<unknown>) => unknown
      ? K extends `_${string}`
        ? never
        : K
      : never
    : never
}[keyof TInstance],
'constructor' | 'connect' | 'dup' | 'fetch' | 'alarm' | 'webSocketMessage' | 'webSocketClose' | 'webSocketError'>
