import { callable, type CallableMetadata } from 'agents'

import type { CallableCarrier, CallableMethodsCarrier, Constructor } from './types'
import { isFunction, restoreSuppressedAccessors, suppressThrowingAccessors } from './utils'

export function isCallableMethod<TClass extends Constructor>(Base: TClass, methodName: string): boolean {
  const candidate = Object.create(Base.prototype) as Partial<CallableCarrier>

  if (!('_isCallable' in candidate) || !isFunction(candidate._isCallable)) {
    return false
  }

  try {
    return candidate._isCallable(methodName)
  } catch {
    return false
  }
}

export function getCallableMetadataMap<TClass extends Constructor>(Base: TClass): Map<string, CallableMetadata> {
  const candidate = Object.create(Base.prototype) as Partial<CallableMethodsCarrier>

  if (!('getCallableMethods' in candidate) || !isFunction(candidate.getCallableMethods)) {
    return new Map()
  }

  const suppressed = suppressThrowingAccessors(Base.prototype)

  try {
    return candidate.getCallableMethods()
  } catch {
    return new Map()
  } finally {
    restoreSuppressedAccessors(suppressed)
  }
}

export function decorateCallableMethod<TMethod extends (...args: Array<unknown>) => unknown>(
  Base: Constructor,
  methodName: string,
  wrappedMethod: TMethod,
  callableMetadataByMethod: ReadonlyMap<string, CallableMetadata>,
): TMethod {
  const callableMetadata = callableMetadataByMethod.get(methodName)

  if (callableMetadata) {
    return callable(callableMetadata)(wrappedMethod, {} as ClassMethodDecoratorContext) as TMethod
  }

  if (isCallableMethod(Base, methodName)) {
    return callable()(wrappedMethod, {} as ClassMethodDecoratorContext) as TMethod
  }

  return wrappedMethod
}
