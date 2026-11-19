import { describe, expect, it, vi } from 'vitest'
import { createAudioDuckPlayer } from '../src/duckPlayer.js'
import { createSidechainNarrator, estimateSpeechMs } from '../src/narrator.js'
import {
  createManualScheduler,
  MockAudioContext,
  MockSpeechSynthesis,
  MockUtterance,
} from './mocks/webAudioMock.js'

function createDeferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('createSidechainNarrator', () => {
  it('estimates speech duration with minimum floor', () => {
    expect(estimateSpeechMs('hi')).toBe(1200)
    expect(estimateSpeechMs('a'.repeat(100))).toBe(7000)
  })

  it('plays decoded audio from ttsProvider with sidechain metering', async () => {
    const ctx = new MockAudioContext()
    ctx.decodeResultDuration = 2.5
    const { scheduler } = createManualScheduler()
    const player = createAudioDuckPlayer({
      createAudioContext: () => ctx as unknown as AudioContext,
      scheduler,
    })

    const ttsProvider = vi.fn(async () => new ArrayBuffer(16))
    const narrator = createSidechainNarrator({
      player,
      ttsProvider,
    })

    const beat = await narrator.speak('Welcome to the observatory.')
    expect(beat).not.toBeNull()
    expect(beat!.fallback).toBe(false)
    expect(beat!.durationMs).toBe(2500)
    expect(ttsProvider).toHaveBeenCalledTimes(1)
    expect(ctx.bufferSources).toHaveLength(1)
    expect(ctx.bufferSources[0]!.startedAt).toBe(0)

    ctx.bufferSources[0]!.triggerEnded()
    await beat!.finished
    expect(narrator.isSpeaking).toBe(false)
  })

  it('falls back to speechSynthesis when ttsProvider fails or is omitted', async () => {
    const ctx = new MockAudioContext()
    const { scheduler } = createManualScheduler()
    const player = createAudioDuckPlayer({
      createAudioContext: () => ctx as unknown as AudioContext,
      scheduler,
    })
    const synth = new MockSpeechSynthesis()

    const narrator = createSidechainNarrator({
      player,
      ttsProvider: async () => {
        throw new Error('TTS offline')
      },
      speechSynthesis: synth as unknown as SpeechSynthesis,
      Utterance: MockUtterance as unknown as typeof SpeechSynthesisUtterance,
      locale: 'en-US',
      fallbackDuckAmount: 0.38,
    })

    const beat = await narrator.speak('Fallback narration line.')
    expect(beat).not.toBeNull()
    expect(beat!.fallback).toBe(true)
    expect(player.getDuckGain()).toBe(0.38)
    expect(synth.cancelCalls).toBe(1)
    expect(synth.spoken).toHaveLength(1)
    expect(synth.spoken[0]!.text).toBe('Fallback narration line.')
    expect(synth.spoken[0]!.lang).toBe('en-US')

    synth.spoken[0]!.onend?.()
    await beat!.finished
    expect(player.getDuckGain()).toBe(1)
  })

  it('plays enqueued lines sequentially and supports clearQueue', async () => {
    const ctx = new MockAudioContext()
    const { scheduler } = createManualScheduler()
    const player = createAudioDuckPlayer({
      createAudioContext: () => ctx as unknown as AudioContext,
      scheduler,
    })

    const order: string[] = []
    const narrator = createSidechainNarrator({
      player,
      ttsProvider: async (text) => {
        order.push(`tts:${text}`)
        return new Blob([new Uint8Array([1, 2, 3, 4])])
      },
    })

    const p1 = narrator.enqueue('Line one')
    const p2 = narrator.enqueue('Line two')
    const p3 = narrator.enqueue('Line three')

    const beat1 = await p1
    expect(beat1).not.toBeNull()
    expect(order).toEqual(['tts:Line one'])
    expect(narrator.queueLength).toBe(2)

    // Cancel remaining queued items while Line one is still playing
    narrator.clearQueue()
    expect(await p2).toBeNull()
    expect(await p3).toBeNull()
    expect(narrator.queueLength).toBe(0)

    // Active line still finishes cleanly
    ctx.bufferSources[0]!.triggerEnded()
    await beat1!.finished
    expect(order).toEqual(['tts:Line one'])
  })

  it('aborts in-flight ttsProvider requests and cancels queue on stop()', async () => {
    const ctx = new MockAudioContext()
    const { scheduler } = createManualScheduler()
    const player = createAudioDuckPlayer({
      createAudioContext: () => ctx as unknown as AudioContext,
      scheduler,
    })

    const deferred = createDeferred<ArrayBuffer>()
    let receivedSignal: AbortSignal | undefined
    const narrator = createSidechainNarrator({
      player,
      ttsProvider: (_text, signal) => {
        receivedSignal = signal
        return deferred.promise
      },
    })

    const speakingPromise = narrator.speak('Slow synthesis')
    const queuedPromise = narrator.enqueue('Queued after')

    expect(receivedSignal?.aborted).toBe(false)
    narrator.stop()
    expect(receivedSignal?.aborted).toBe(true)

    deferred.resolve(new ArrayBuffer(8))
    expect(await speakingPromise).toBeNull()
    expect(await queuedPromise).toBeNull()
    expect(ctx.bufferSources).toHaveLength(0)
  })

  it('supersedes an earlier speak() call when a newer speak() arrives mid-flight', async () => {
    const ctx = new MockAudioContext()
    const { scheduler } = createManualScheduler()
    const player = createAudioDuckPlayer({
      createAudioContext: () => ctx as unknown as AudioContext,
      scheduler,
    })

    const first = createDeferred<ArrayBuffer>()
    const narrator = createSidechainNarrator({
      player,
      ttsProvider: (text) => {
        if (text === 'First') return first.promise
        return Promise.resolve(new ArrayBuffer(8))
      },
    })

    const pFirst = narrator.speak('First')
    const beatSecond = await narrator.speak('Second')
    first.resolve(new ArrayBuffer(8))

    expect(await pFirst).toBeNull()
    expect(beatSecond).not.toBeNull()
    expect(ctx.bufferSources).toHaveLength(1)
  })

  it('warms sequentially without duplicating identical text requests', async () => {
    const ctx = new MockAudioContext()
    const { scheduler } = createManualScheduler()
    const player = createAudioDuckPlayer({
      createAudioContext: () => ctx as unknown as AudioContext,
      scheduler,
    })

    const ttsProvider = vi.fn(async () => new ArrayBuffer(8))
    const narrator = createSidechainNarrator({ player, ttsProvider })

    await Promise.all([narrator.warm('Cached line'), narrator.warm('Cached line')])
    expect(ttsProvider).toHaveBeenCalledTimes(1)

    const beat = await narrator.speak('Cached line')
    expect(beat).not.toBeNull()
    expect(ttsProvider).toHaveBeenCalledTimes(1)

    // External player is not closed by narrator.dispose()
    await narrator.dispose()
    expect(ctx.closeCalls).toBe(0)
    await player.dispose()
    expect(ctx.closeCalls).toBe(1)

    // Internally owned player IS closed by narrator.dispose()
    const ownedCtx = new MockAudioContext()
    const ownedNarrator = createSidechainNarrator({
      playerOptions: {
        createAudioContext: () => ownedCtx as unknown as AudioContext,
        scheduler,
      },
      ttsProvider,
    })
    await ownedNarrator.speak('Owned player line')
    await ownedNarrator.dispose()
    expect(ownedCtx.closeCalls).toBe(1)
  })
})
