import { NO_SHORT_CIRCUIT, RESERVED_METHOD_NAMES } from './constants'
import { attachClientPostInvokeHooks } from './compose'
import type {
  ClientUsablePlugin,
  DurableObjectIdLike,
  ExplicitRpcValue,
  RpcClientCall,
  RpcClientMiddlewareInput,
  RpcClientOf,
  RpcClientPluginHooks,
  RpcNamespace,
  RpcState,
  RuntimeClientHooks,
} from './types'
import { appendContextToArgs, bindPassthrough, hasOwn, isFunction, isObject, resolveHookValue, unwrapExplicitRpcValue } from './utils'

const CLIENT_CALL_MARKER = Symbol('mulroy/cloudflare-rpc/client-call')

interface ClientCallStateBase<TContext extends object> {
  value: unknown
  context: TContext
  invokedNative: boolean
  successTransforms: Array<(value: unknown, context: TContext) => unknown>
  errorTransforms: Array<(error: unknown, context: TContext) => unknown>
  finishListeners: Array<(input: { context: TContext; status: 'success' | 'error' }) => void>
}

type ClientCallState<TContext extends object> = ClientCallStateBase<TContext> & {
  readonly [CLIENT_CALL_MARKER]: true
}

/**
 * Fluent client builder for Durable Object namespaces.
 */
export interface RpcClientNamespace<TStub extends object, TContext extends object> {
  /**
   * Adds client-side hooks and middleware to subsequent stub lookups.
   */
  use<TPluginStub extends object>(plugin: ClientUsablePlugin<TPluginStub, TContext>): RpcClientNamespace<TStub, TContext>

  /**
   * Returns a typed RPC client for a specific Durable Object id.
   */
  get(id: DurableObjectIdLike, options?: { context?: TContext }): RpcClientOf<TStub>

  /**
   * Returns a typed RPC client for a named Durable Object.
   */
  getByName(name: string, options?: { context?: TContext }): RpcClientOf<TStub>
}

/**
 * Fluent client builder for an already-resolved native RPC stub.
 */
export interface RpcClientStub<TStub extends object, TContext extends object> {
  /**
   * Adds client-side hooks and middleware to the wrapped stub.
   */
  use<TPluginStub extends object>(plugin: ClientUsablePlugin<TPluginStub, TContext>): RpcClientStub<TStub, TContext>

  /**
   * Materializes the wrapped typed client.
   */
  stub(options?: { context?: TContext }): RpcClientOf<TStub>
}

/**
 * Creates a middleware-compatible client call wrapper.
 */
export function rpcClientCall<TContext extends object = object>(
  value: unknown,
  options?: { context?: TContext; invokedNative?: boolean },
): RpcClientCall<TContext> {
  return createRpcClientCall({
    value,
    context: options?.context ?? ({} as TContext),
    invokedNative: options?.invokedNative ?? false,
    successTransforms: [],
    errorTransforms: [],
    finishListeners: [],
  })
}

/**
 * Entry points for creating typed RPC clients from either a namespace or a raw native stub.
 */
export const rpcClient = {
  /**
   * Creates a typed client builder from a Durable Object namespace binding.
   */
  fromNamespace<TStub extends object, TContext extends object = object>(binding: RpcNamespace<TStub>): RpcClientNamespace<TStub, TContext> {
    return createNamespaceWrapper<TStub, TContext>(binding, [])
  },

  /**
   * Creates a typed client builder from an existing native RPC stub.
   */
  fromStub<TStub extends object, TContext extends object = object>(binding: TStub): RpcClientStub<TStub, TContext> {
    return createStubWrapper<TStub, TContext>(binding, [])
  },
}

function createRpcClientCall<TContext extends object>(state: ClientCallStateBase<TContext>): RpcClientCall<TContext> {
  const markedState: ClientCallState<TContext> = {
    ...state,
    [CLIENT_CALL_MARKER]: true,
  }

  const call: RpcClientCall<TContext> & ClientCallState<TContext> = {
    value: markedState.value,
    context: markedState.context,
    invokedNative: markedState.invokedNative,
    successTransforms: markedState.successTransforms,
    errorTransforms: markedState.errorTransforms,
    finishListeners: markedState.finishListeners,
    [CLIENT_CALL_MARKER]: true,
    mapSuccess(transform) {
      return createRpcClientCall({
        ...markedState,
        successTransforms: [...markedState.successTransforms, transform],
      })
    },
    mapError(transform) {
      return createRpcClientCall({
        ...markedState,
        errorTransforms: [...markedState.errorTransforms, transform],
      })
    },
    onFinish(listener) {
      return createRpcClientCall({
        ...markedState,
        finishListeners: [...markedState.finishListeners, listener],
      })
    },
  }

  return call
}

function isRpcClientCall<TContext extends object>(value: unknown): value is RpcClientCall<TContext> & ClientCallState<TContext> {
  return isObject(value) && hasOwn(value, CLIENT_CALL_MARKER) && value[CLIENT_CALL_MARKER] === true
}

function applyClientSuccessTransforms<TContext extends object>(
  value: unknown,
  context: TContext,
  transforms: ReadonlyArray<(value: unknown, context: TContext) => unknown>,
): unknown {
  let result = value

  for (const transform of transforms) {
    result = resolveHookValue(result, transform(result, context))
  }

  return result
}

function applyClientErrorTransforms<TContext extends object>(
  error: unknown,
  context: TContext,
  transforms: ReadonlyArray<(error: unknown, context: TContext) => unknown>,
): unknown {
  let finalError = error

  for (const transform of transforms) {
    finalError = resolveHookValue(finalError, transform(finalError, context))
  }

  return finalError
}

function runClientFinishListeners<TContext extends object>(
  context: TContext,
  status: 'success' | 'error',
  listeners: ReadonlyArray<(input: { context: TContext; status: 'success' | 'error' }) => void>,
) {
  for (const listener of listeners) {
    listener({ context, status })
  }
}

function materializeImmediateClientCall<TContext extends object>(
  call: ClientCallState<TContext>,
): unknown {
  let status: 'success' | 'error' = 'success'

  try {
    return applyClientSuccessTransforms(call.value, call.context, call.successTransforms)
  } catch (error: unknown) {
    status = 'error'
    throw applyClientErrorTransforms(error, call.context, call.errorTransforms)
  } finally {
    runClientFinishListeners(call.context, status, call.finishListeners)
  }
}

function getNativeProperty(target: object, prop: PropertyKey): unknown {
  return Reflect.get(target, prop, target)
}

function wrapLazyResult<TContext extends object>(
  nativeResult: unknown,
  call: ClientCallState<TContext>,
  callTarget?: object,
): unknown {
  if (!isObject(nativeResult) && !isFunction(nativeResult)) {
    return materializeImmediateClientCall({
      ...call,
      value: nativeResult,
    })
  }

  const getTrap: ProxyHandler<object>['get'] = (target, prop, receiver) => {
    if (prop === 'then') {
      return (
        onFulfilled?: (value: unknown) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) => {
        const nativeThen = getNativeProperty(target, 'then')

        if (!isFunction(nativeThen)) {
          try {
            const resolved = applyClientSuccessTransforms(target, call.context, call.successTransforms)
            runClientFinishListeners(call.context, 'success', call.finishListeners)
            return Promise.resolve(resolved).then(onFulfilled, onRejected)
          } catch (hookError: unknown) {
            const transformedError = applyClientErrorTransforms(hookError, call.context, call.errorTransforms)
            runClientFinishListeners(call.context, 'error', call.finishListeners)
            return Promise.reject(transformedError).then(onFulfilled, onRejected)
          }
        }

        return nativeThen.call(
          target,
          (value: unknown) => {
            try {
              const transformed = applyClientSuccessTransforms(value, call.context, call.successTransforms)
              runClientFinishListeners(call.context, 'success', call.finishListeners)
              return onFulfilled ? onFulfilled(transformed) : transformed
            } catch (hookError: unknown) {
              const transformedError = applyClientErrorTransforms(hookError, call.context, call.errorTransforms)
              runClientFinishListeners(call.context, 'error', call.finishListeners)
              return onRejected ? onRejected(transformedError) : Promise.reject(transformedError)
            }
          },
          (error: unknown) => {
            const transformed = applyClientErrorTransforms(error, call.context, call.errorTransforms)
            runClientFinishListeners(call.context, 'error', call.finishListeners)
            return onRejected ? onRejected(transformed) : Promise.reject(transformed)
          },
        )
      }
    }

    const value = Reflect.get(target, prop, receiver)

    if (typeof prop === 'symbol') {
      return bindPassthrough(target, value)
    }

    if (RESERVED_METHOD_NAMES.has(prop) || prop.startsWith('_')) {
      if (prop === 'dup' && isFunction(value)) {
        return wrapLazyResult(value, call, target)
      }

      return bindPassthrough(target, value)
    }

    if (isFunction(value)) {
      return wrapLazyResult(value, call, target)
    }

    if (isObject(value)) {
      return wrapLazyResult(value, call)
    }

    return value
  }

  if (isFunction(nativeResult)) {
    return new Proxy(nativeResult, {
      get: getTrap,
      apply(target: (...args: Array<unknown>) => unknown, _thisArg, argArray) {
        const pipelinedResult = Reflect.apply(target, callTarget ?? target, argArray)
        return wrapLazyResult(pipelinedResult, call)
      },
    })
  }

  return new Proxy(nativeResult as object, {
    get: getTrap,
  })
}

function materializeClientCall<TContext extends object>(call: RpcClientCall<TContext>): unknown {
  if (!isRpcClientCall(call)) {
    throw new Error('Client RPC middleware must return a RpcClientCall. Return next() or rpcClientCall(value).')
  }

  if (!call.invokedNative) {
    return materializeImmediateClientCall(call)
  }

  if (
    call.successTransforms.length === 0
    && call.errorTransforms.length === 0
    && call.finishListeners.length === 0
  ) {
    return call.value
  }

  return wrapLazyResult(call.value, call)
}

function composeClientMiddleware<TContext extends object>(
  method: string,
  state: RpcState<TContext>,
  middlewares: ReadonlyArray<NonNullable<RuntimeClientHooks<TContext>['middleware']>>,
  terminal: (state: RpcState<TContext>) => RpcClientCall<TContext>,
): RpcClientCall<TContext> {
  const dispatch = (index: number, currentState: RpcState<TContext>): RpcClientCall<TContext> => {
    const middleware = middlewares[index]

    if (!middleware) {
      return terminal(currentState)
    }

    let nextCalled = false

    const result = middleware({
      method,
      args: currentState.args,
      context: currentState.context,
      next: (patch) => {
        if (nextCalled) {
          throw new Error(`Client RPC middleware for ${method} called next() multiple times`)
        }

        nextCalled = true
        return dispatch(index + 1, {
          args: patch?.args ?? currentState.args,
          context: patch?.context ?? currentState.context,
        })
      },
    })

    if (!isRpcClientCall(result)) {
      throw new Error(`Client RPC middleware for ${method} must return next() or rpcClientCall(value)`)
    }

    return result
  }

  return dispatch(0, state)
}

function createNamespaceWrapper<TStub extends object, TContext extends object>(
  namespace: RpcNamespace<TStub>,
  plugins: RuntimeClientHooks<TContext>[],
): RpcClientNamespace<TStub, TContext> {
  return {
    use(plugin) {
      return createNamespaceWrapper(namespace, [...plugins, plugin.client as RuntimeClientHooks<TContext>])
    },

    get(id, options) {
      const rawStub = namespace.get(id)
      return wrapClientStub<TStub, TContext>(rawStub as TStub, plugins, options?.context ?? ({} as TContext))
    },

    getByName(name, options) {
      if (!namespace.idFromName) {
        throw new Error('rpcClient.fromNamespace(namespace).getByName() requires a namespace with idFromName(name)')
      }

      const rawStub = namespace.get(namespace.idFromName(name))
      return wrapClientStub<TStub, TContext>(rawStub as TStub, plugins, options?.context ?? ({} as TContext))
    },
  }
}

function createStubWrapper<TStub extends object, TContext extends object>(
  rawStub: TStub,
  plugins: RuntimeClientHooks<TContext>[],
): RpcClientStub<TStub, TContext> {
  return {
    use(plugin) {
      return createStubWrapper(rawStub, [...plugins, plugin.client as RuntimeClientHooks<TContext>])
    },

    stub(options) {
      return wrapClientStub<TStub, TContext>(rawStub, plugins, options?.context ?? ({} as TContext))
    },
  }
}

function wrapClientStub<TStub extends object, TContext extends object>(
  stub: TStub,
  plugins: RuntimeClientHooks<TContext>[],
  baseContext: TContext,
): RpcClientOf<TStub> {
  return new Proxy(stub, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)

      if (typeof prop === 'symbol') {
        return bindPassthrough(target, value)
      }

      if (RESERVED_METHOD_NAMES.has(prop) || prop.startsWith('_')) {
        return bindPassthrough(target, value)
      }

      if (!isFunction(value)) {
        return value
      }

      return (...args: unknown[]): unknown => {
        let context = { ...baseContext }
        let callArgs = args
        let shortCircuitResult: unknown | typeof NO_SHORT_CIRCUIT = NO_SHORT_CIRCUIT

        try {
          for (const hooks of plugins) {
            if (!hooks.onRequest) {
              continue
            }

            const patch = hooks.onRequest({
              method: prop,
              args: callArgs,
              context,
            })

            if (!patch) {
              continue
            }

            if (patch.args) callArgs = patch.args
            if (patch.context) context = patch.context

            if (hasOwn(patch, 'result')) {
              shortCircuitResult = unwrapExplicitRpcValue(patch.result)
              break
            }
          }

          const call = shortCircuitResult !== NO_SHORT_CIRCUIT
            ? rpcClientCall<TContext>(shortCircuitResult, { context })
            : composeClientMiddleware(
                prop,
                {
                  args: callArgs,
                  context,
                },
                plugins.flatMap((hooks) => hooks.middleware ? [hooks.middleware] : []),
                (state) => rpcClientCall<TContext>(
                  value(...appendContextToArgs(state.args, state.context)),
                  { context: state.context, invokedNative: true },
                ),
              )

          return materializeClientCall(attachClientPostInvokeHooks(prop, call, plugins))
        } catch (error: unknown) {
          let transformedError = error

          for (const hooks of plugins) {
            if (hooks.onError) {
              transformedError = resolveHookValue(
                transformedError,
                hooks.onError(transformedError, { method: prop, context }),
              )
            }
          }

          for (const hooks of plugins) {
            hooks.onFinish?.({ method: prop, context, status: 'error' })
          }

          throw transformedError
        }
      }
    },
  }) as unknown as RpcClientOf<TStub>
}

export type {
  ClientUsablePlugin,
  DurableObjectIdLike,
  ExplicitRpcValue,
  RpcClientCall,
  RpcClientMiddlewareInput,
  RpcClientPluginHooks,
  RpcNamespace,
}
