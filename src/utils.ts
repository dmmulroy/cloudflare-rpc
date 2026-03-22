import { RPC_CONTEXT_ENVELOPE_VERSION, RESERVED_METHOD_NAMES } from './constants'
import type { ExplicitRpcValue, MethodKey, RpcContextEnvelope, SuppressedAccessor } from './types'

export function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null
}

export function isFunction(value: unknown): value is (...args: Array<unknown>) => unknown {
  return typeof value === 'function'
}

export function hasOwn<TKey extends PropertyKey>(value: object, key: TKey): value is object & Record<TKey, unknown> {
  return Object.prototype.hasOwnProperty.call(value, key)
}

export function isExplicitRpcValue(value: unknown): value is ExplicitRpcValue<unknown> {
  return isObject(value)
    && hasOwn(value, '__mulroyCloudflareRpcExplicitValue')
    && value.__mulroyCloudflareRpcExplicitValue === true
    && hasOwn(value, 'value')
}

export function unwrapExplicitRpcValue(value: unknown): unknown {
  return isExplicitRpcValue(value) ? value.value : value
}

export function resolveHookValue(currentValue: unknown, transformedValue: unknown): unknown {
  if (isExplicitRpcValue(transformedValue)) {
    return transformedValue.value
  }

  if (transformedValue !== undefined) {
    return transformedValue
  }

  return currentValue
}

export function shouldWrapMethod(name: MethodKey, value: unknown): value is (...args: Array<unknown>) => unknown {
  if (typeof name !== 'string') return false
  if (RESERVED_METHOD_NAMES.has(name)) return false
  if (name.startsWith('_')) return false
  return isFunction(value)
}

export function getPrototypeMethodNames(prototype: object): string[] {
  return Object.getOwnPropertyNames(prototype).filter((name) => {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name)
    return shouldWrapMethod(name, descriptor?.value)
  })
}

export function suppressThrowingAccessors(prototype: object): SuppressedAccessor[] {
  const suppressed: SuppressedAccessor[] = []
  let current: object | null = prototype

  while (current && current !== Object.prototype) {
    for (const propertyName of Object.getOwnPropertyNames(current)) {
      const descriptor = Object.getOwnPropertyDescriptor(current, propertyName)
      if (!descriptor?.get || descriptor.configurable === false) {
        continue
      }

      Object.defineProperty(current, propertyName, {
        configurable: descriptor.configurable,
        enumerable: descriptor.enumerable ?? false,
        get() {
          return undefined
        },
        set: descriptor.set,
      })

      suppressed.push({
        prototype: current,
        propertyName,
        descriptor,
      })
    }

    current = Object.getPrototypeOf(current)
  }

  return suppressed
}

export function restoreSuppressedAccessors(suppressed: ReadonlyArray<SuppressedAccessor>) {
  for (const { prototype, propertyName, descriptor } of [...suppressed].reverse()) {
    Object.defineProperty(prototype, propertyName, descriptor)
  }
}

export function createContextEnvelope<TContext extends object>(context: TContext): RpcContextEnvelope<TContext> {
  return {
    __mulroyCloudflareRpcContext: true,
    version: RPC_CONTEXT_ENVELOPE_VERSION,
    context,
  }
}

export function isContextEnvelope<TContext extends object>(value: unknown): value is RpcContextEnvelope<TContext> {
  if (!isObject(value)) {
    return false
  }

  if (!hasOwn(value, '__mulroyCloudflareRpcContext') || value.__mulroyCloudflareRpcContext !== true) {
    return false
  }

  if (!hasOwn(value, 'version') || value.version !== RPC_CONTEXT_ENVELOPE_VERSION) {
    return false
  }

  return hasOwn(value, 'context') && isObject(value.context)
}

export function hasContextProperties(context: object): boolean {
  return Object.keys(context).length > 0
}

export function extractContextFromArgs<TContext extends object>(args: ReadonlyArray<unknown>): {
  context: TContext
  methodArgs: unknown[]
} {
  if (args.length === 0) {
    return {
      context: {} as TContext,
      methodArgs: [],
    }
  }

  const lastArg = args[args.length - 1]

  if (!isContextEnvelope<TContext>(lastArg)) {
    return {
      context: {} as TContext,
      methodArgs: [...args],
    }
  }

  return {
    context: lastArg.context,
    methodArgs: args.slice(0, -1),
  }
}

export function appendContextToArgs<TContext extends object>(args: ReadonlyArray<unknown>, context: TContext): unknown[] {
  if (!hasContextProperties(context)) {
    return [...args]
  }

  return [...args, createContextEnvelope(context)]
}

export function bindPassthrough(target: object, value: unknown): unknown {
  if (isFunction(value)) {
    return value.bind(target)
  }

  return value
}

export function getProperty(value: object, key: PropertyKey): unknown {
  try {
    return Reflect.get(value, key)
  } catch {
    return undefined
  }
}

export function hasProperty(value: object, key: PropertyKey): boolean {
  try {
    return key in value
  } catch {
    return false
  }
}
