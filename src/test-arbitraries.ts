import fc from 'fast-check'

import { RESERVED_METHOD_NAMES } from './constants'

function omitUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  const entries = Object.entries(value).filter(([, entry]) => entry !== undefined)
  return Object.fromEntries(entries) as Partial<T>
}

export const primitiveArgArb = fc.oneof(
  fc.string(),
  fc.integer(),
  fc.boolean(),
  fc.constant(null),
)

export const primitiveArgsArb = fc.array(primitiveArgArb, { maxLength: 6 })

export const contextArb = fc.record({
  actor: fc.option(fc.string({ minLength: 1, maxLength: 32 }), { nil: undefined }),
  requestId: fc.option(fc.string({ minLength: 1, maxLength: 32 }), { nil: undefined }),
  middlewareTrail: fc.option(fc.array(fc.string({ minLength: 1, maxLength: 32 }), { maxLength: 5 }), { nil: undefined }),
}).map((context) => omitUndefined(context))

export const nonReservedMethodNameArb = fc
  .string({ minLength: 1, maxLength: 20 })
  .filter((name) => !name.startsWith('_') && !RESERVED_METHOD_NAMES.has(name))

export const reservedMethodNameArb = fc.constantFrom(...RESERVED_METHOD_NAMES)

export const plainSerializableValueArb: fc.Arbitrary<unknown> = fc.letrec((tie) => ({
  value: fc.oneof(
    fc.constant(null),
    fc.boolean(),
    fc.integer(),
    fc.string(),
    fc.array(tie('value'), { maxLength: 4 }),
    fc.dictionary(fc.string({ minLength: 1, maxLength: 12 }), tie('value')),
  ),
})).value

export const explicitTransformValueArb = fc.oneof(
  fc.string(),
  fc.integer(),
  fc.boolean(),
  fc.constant(null),
  fc.constant(undefined),
)
