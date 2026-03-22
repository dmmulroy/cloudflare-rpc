import { INTERNAL_MARKER, NO_SHORT_CIRCUIT } from './constants'
import { applyServerErrorHooks, applyServerSuccessHooks, composeServerMiddleware, runServerFinishHooks } from './compose'
import { decorateCallableMethod, getCallableMetadataMap } from './metadata-agents'
import type {
  Constructor,
  PublicMethodNames,
  RuntimeServerHooks,
  ServerUsablePlugin,
  WrappedMarkerCarrier,
} from './types'
import { extractContextFromArgs, getPrototypeMethodNames, hasOwn, isFunction, unwrapExplicitRpcValue } from './utils'

export interface RpcServerBuilder<TClass extends Constructor, TContext extends object> {
  use<TPluginInstance extends object>(plugin: ServerUsablePlugin<TPluginInstance, TContext>): RpcServerBuilder<TClass, TContext>
  method<TMethod extends PublicMethodNames<InstanceType<TClass>>>(name: TMethod): RpcServerMethodBuilder<TClass, TContext>
  build(): TClass
}

export interface RpcServerMethodBuilder<TClass extends Constructor, TContext extends object> {
  use<TPluginInstance extends object>(plugin: ServerUsablePlugin<TPluginInstance, TContext>): RpcServerMethodBuilder<TClass, TContext>
  done(): RpcServerBuilder<TClass, TContext>
}

export function rpcServer<TClass extends Constructor, TContext extends object = object>(Base: TClass): RpcServerBuilder<TClass, TContext> {
  const globalPlugins: RuntimeServerHooks<TContext>[] = []
  const methodPlugins = new Map<string, RuntimeServerHooks<TContext>[]>()

  const builder: RpcServerBuilder<TClass, TContext> = {
    use(plugin) {
      globalPlugins.push(plugin.server as RuntimeServerHooks<TContext>)
      return builder
    },

    method(name) {
      const methodName = String(name)

      if (!methodPlugins.has(methodName)) {
        methodPlugins.set(methodName, [])
      }
      const perMethod = methodPlugins.get(methodName)!

      const methodBuilder: RpcServerMethodBuilder<TClass, TContext> = {
        use(plugin) {
          perMethod.push(plugin.server as RuntimeServerHooks<TContext>)
          return methodBuilder
        },
        done() {
          return builder
        },
      }
      return methodBuilder
    },

    build() {
      return wrapServerClass(Base, globalPlugins, methodPlugins)
    },
  }

  return builder
}

function wrapServerClass<TClass extends Constructor, TContext extends object>(
  Base: TClass,
  globalPlugins: RuntimeServerHooks<TContext>[],
  methodPlugins: Map<string, RuntimeServerHooks<TContext>[]>,
): TClass {
  const wrappedBase = Base as TClass & WrappedMarkerCarrier

  if (wrappedBase[INTERNAL_MARKER] === true) {
    return Base
  }

  const methodNames = getPrototypeMethodNames(Base.prototype)
  const callableMetadataByMethod = getCallableMetadataMap(Base)

  for (const methodName of methodNames) {
    const originalMethod = Reflect.get(Base.prototype, methodName)
    if (!isFunction(originalMethod)) {
      continue
    }

    const allHooks = [
      ...globalPlugins,
      ...(methodPlugins.get(methodName) ?? []),
    ]
    const middlewares = allHooks.flatMap((hooks) => hooks.middleware ? [hooks.middleware] : [])

    const wrappedMethod = async function wrappedMethod(this: object, ...args: Array<unknown>): Promise<unknown> {
      const extracted = extractContextFromArgs<TContext>(args)
      let context = extracted.context
      let methodArgs = extracted.methodArgs
      let shortCircuitResult: unknown | typeof NO_SHORT_CIRCUIT = NO_SHORT_CIRCUIT

      for (const hooks of allHooks) {
        if (!hooks.onRequest) {
          continue
        }

        const patch = hooks.onRequest({
          instance: this,
          method: methodName,
          args: methodArgs,
          context,
        })

        if (!patch) {
          continue
        }

        if (patch.args) methodArgs = patch.args
        if (patch.context) context = patch.context

        if (hasOwn(patch, 'result')) {
          shortCircuitResult = unwrapExplicitRpcValue(patch.result)
          break
        }
      }

      let status: 'success' | 'error' = 'success'

      try {
        const outcome = shortCircuitResult !== NO_SHORT_CIRCUIT
          ? {
              value: shortCircuitResult,
              context,
            }
          : await composeServerMiddleware(
              this,
              methodName,
              {
                args: methodArgs,
                context,
              },
              middlewares,
              async (state) => originalMethod.apply(this, state.args),
            )

        context = outcome.context
        return applyServerSuccessHooks(outcome.value, this, methodName, context, allHooks)
      } catch (error: unknown) {
        status = 'error'
        throw applyServerErrorHooks(error, this, methodName, context, allHooks)
      } finally {
        runServerFinishHooks(this, methodName, context, status, allHooks)
      }
    }

    const decoratedMethod = decorateCallableMethod(Base, methodName, wrappedMethod, callableMetadataByMethod)

    Object.defineProperty(Base.prototype, methodName, {
      configurable: true,
      writable: true,
      value: decoratedMethod,
    })
  }

  Object.defineProperty(wrappedBase, INTERNAL_MARKER, {
    configurable: false,
    enumerable: false,
    value: true,
  })

  return Base
}

export type { Constructor, PublicMethodNames, ServerUsablePlugin }
