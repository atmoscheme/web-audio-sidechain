import { describe, expect, it } from 'vitest'
import { createProceduralClick } from '../src/proceduralClick.js'
import { MockAudioContext } from './mocks/webAudioMock.js'

describe('createProceduralClick', () => {
  it('unlocks context and debounces rapid clicks', async () => {
    const ctx = new MockAudioContext()
    let nowMs = 100

    const clicker = createProceduralClick({
      createAudioContext: () => ctx as unknown as AudioContext,
      now: () => nowMs,
      minIntervalMs: 28,
      frequency: 1480,
      waveform: 'square',
    })

    expect(await clicker.click()).toBe(true)
    expect(ctx.resumeCalls).toBe(1)
    expect(ctx.oscillators).toHaveLength(1)
    expect(ctx.oscillators[0]!.type).toBe('square')
    expect(ctx.oscillators[0]!.frequency.value).toBe(1480)

    // Within 28ms debounce window, throttled
    nowMs = 115
    expect(await clicker.click()).toBe(false)
    expect(ctx.oscillators).toHaveLength(1)

    // Past debounce window, triggers second click
    nowMs = 135
    expect(await clicker.click()).toBe(true)
    expect(ctx.oscillators).toHaveLength(2)

    await clicker.dispose()
    expect(ctx.closeCalls).toBe(1)
  })
})
