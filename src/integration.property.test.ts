import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { SELF } from 'cloudflare:test'

describe('cloudflare-rpc integration properties', () => {
  it('reserve route preserves RpcResult semantics across quantities', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 8 }), async (qty) => {
        const response = await SELF.fetch(`https://example.com/reserve?qty=${qty}`)
        const body = await response.json()

        if (qty > 3) {
          expect(response.status).toBe(409)
          expect(body).toEqual({
            status: 'error',
            error: { code: 'OUT_OF_STOCK' },
          })
          return
        }

        expect(response.status).toBe(200)
        expect(body).toEqual({
          status: 'ok',
          value: { reserved: qty },
        })
      }),
    )
  })

  it('nested reserve route preserves nested RpcResult semantics across quantities', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 8 }), async (qty) => {
        const response = await SELF.fetch(`https://example.com/nested?qty=${qty}`)
        expect(response.status).toBe(200)

        if (qty > 3) {
          expect(await response.json()).toEqual({
            nestedStatus: 'error',
            nestedValue: undefined,
            nestedError: { code: 'OUT_OF_STOCK' },
          })
          return
        }

        expect(await response.json()).toEqual({
          nestedStatus: 'ok',
          nestedValue: { reserved: qty },
          nestedError: undefined,
        })
      }),
    )
  })

  it('pipelined counter routes preserve arithmetic over generated inputs', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: -100, max: 100 }),
        fc.integer({ min: -100, max: 100 }),
        async (start, amount) => {
          const pipelined = await SELF.fetch(`https://example.com/pipelined-counter?start=${start}&amount=${amount}`)
          expect(pipelined.status).toBe(200)
          expect(await pipelined.json()).toEqual({ value: start + amount })

          const nested = await SELF.fetch(`https://example.com/nested-pipelined-counter?start=${start}&amount=${amount}`)
          expect(nested.status).toBe(200)
          expect(await nested.json()).toEqual({ value: start + amount })
        },
      ),
    )
  })

  it('dup route shares counter state across duplicates', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: -100, max: 100 }),
        fc.integer({ min: -100, max: 100 }),
        fc.integer({ min: -100, max: 100 }),
        async (start, first, second) => {
          const response = await SELF.fetch(
            `https://example.com/dup-counter?start=${start}&first=${first}&second=${second}`,
          )

          expect(response.status).toBe(200)
          expect(await response.json()).toEqual({
            afterFirst: start + first,
            afterSecond: start + first + second,
          })
        },
      ),
    )
  })
})
