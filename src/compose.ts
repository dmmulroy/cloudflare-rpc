import type {
  RpcClientCall,
  RpcState,
  RuntimeClientHooks,
  RuntimeServerHooks,
  ServerMiddlewareOutcome,
} from './types'
import { resolveHookValue } from './utils'

export function applyServerSuccessHooks<TContext extends object>(
  value: unknown,
  instance: object,
  method: string,
  context: TContext,
  plugins: RuntimeServerHooks<TContext>[],
): unknown {
  let result = value

  for (const hooks of plugins) {
    if (hooks.onSuccess) {
      const transformed = hooks.onSuccess({
        instance,
        method,
        context,
        value: result,
      })
      result = resolveHookValue(result, transformed)
    }
  }

  return result
}

export function applyServerErrorHooks<TContext extends object>(
  error: unknown,
  instance: object,
  method: string,
  context: TContext,
  plugins: RuntimeServerHooks<TContext>[],
): unknown {
  let finalError = error

  for (const hooks of plugins) {
    if (hooks.onError) {
      const transformed = hooks.onError({
        instance,
        method,
        context,
        error: finalError,
      })
      finalError = resolveHookValue(finalError, transformed)
    }
  }

  return finalError
}

export function runServerFinishHooks<TContext extends object>(
  instance: object,
  method: string,
  context: TContext,
  status: 'success' | 'error',
  plugins: RuntimeServerHooks<TContext>[],
) {
  for (const hooks of plugins) {
    hooks.onFinish?.({ instance, method, context, status })
  }
}

export function attachClientPostInvokeHooks<TContext extends object>(
  method: string,
  call: RpcClientCall<TContext>,
  plugins: RuntimeClientHooks<TContext>[],
): RpcClientCall<TContext> {
  let wrapped = call

  for (const hooks of plugins) {
    if (hooks.onSuccess) {
      wrapped = wrapped.mapSuccess((value, context) => hooks.onSuccess!(value, { method, context }))
    }

    if (hooks.onError) {
      wrapped = wrapped.mapError((error, context) => hooks.onError!(error, { method, context }))
    }

    if (hooks.onFinish) {
      wrapped = wrapped.onFinish(({ context, status }) => hooks.onFinish!({ method, context, status }))
    }
  }

  return wrapped
}

export async function composeServerMiddleware<TContext extends object>(
  instance: object,
  method: string,
  state: RpcState<TContext>,
  middlewares: ReadonlyArray<NonNullable<RuntimeServerHooks<TContext>['middleware']>>,
  terminal: (state: RpcState<TContext>) => Promise<unknown>,
): Promise<ServerMiddlewareOutcome<TContext>> {
  const dispatch = async (index: number, currentState: RpcState<TContext>): Promise<ServerMiddlewareOutcome<TContext>> => {
    const middleware = middlewares[index]

    if (!middleware) {
      return {
        value: await terminal(currentState),
        context: currentState.context,
      }
    }

    let nextCalled = false
    let nextContext: TContext | null = null

    const returned = await middleware({
      instance,
      method,
      args: currentState.args,
      context: currentState.context,
      next: async (patch) => {
        if (nextCalled) {
          throw new Error(`Server RPC middleware for ${method} called next() multiple times`)
        }

        nextCalled = true
        const downstream = await dispatch(index + 1, {
          args: patch?.args ?? currentState.args,
          context: patch?.context ?? currentState.context,
        })
        nextContext = downstream.context
        return downstream.value
      },
    })

    if (!nextCalled) {
      return {
        value: returned,
        context: currentState.context,
      }
    }

    if (nextContext === null) {
      throw new Error(`Server RPC middleware for ${method} called next() but no downstream result was produced`)
    }

    return {
      value: returned,
      context: nextContext,
    }
  }

  return dispatch(0, state)
}
