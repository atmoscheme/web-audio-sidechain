import { describe, expect, it } from 'vitest'
import { createAudioDuckPlayer } from '../src/duckPlayer.js'
import {
  createManualScheduler,
  MockAudioContext,
  MockAudioElement,
  MockAudioNode,
} from './mocks/webAudioMock.js'

describe('createAudioDuckPlayer', () => {
  it('builds the Web Audio graph and unlocks suspended contexts', async () => {
    const ctx = new MockAudioContext()
    const el = new MockAudioElement()
    const player = createAudioDuckPlayer({
      createAudioContext: () => ctx as unknown as AudioContext,
      createAudioElement: () => el as unknown as HTMLAudioElement,
    })

    expect(player.state).toBe('uninitialized')
    const bedInput = player.getBedInput()
    expect(bedInput).toBeDefined()
    expect(ctx.gainNodes).toHaveLength(3) // bedInput, gain, duck
    expect(ctx.analyserNodes).toHaveLength(1) // bedAnalyser
    expect(player.state).toBe('suspended')

    await player.play()
    expect(ctx.resumeCalls).toBe(1)
    expect(player.state).toBe('running')
    expect(el.playCalls).toBe(1)
    expect(ctx.mediaSources).toHaveLength(1)

    await player.dispose()
    expect(ctx.closeCalls).toBe(1)
  })

  it('ducks bed gain dynamically based on sidechain voice RMS and ramps back on release', async () => {
    const ctx = new MockAudioContext()
    const manual = createManualScheduler()
    const player = createAudioDuckPlayer({
      createAudioContext: () => ctx as unknown as AudioContext,
      scheduler: manual.scheduler,
      releaseRampSeconds: 0.4,
    })

    await player.unlock()
    const voiceNode = new MockAudioNode() as unknown as AudioNode
    player.sidechainNode(voiceNode)

    expect(manual.pendingCount).toBe(1)
    const voiceMeter = ctx.analyserNodes[1]!
    // Alternating 220 / 36 gives normalized +-0.72, RMS ~0.72
    const loudSamples = new Uint8Array(voiceMeter.fftSize)
    for (let i = 0; i < loudSamples.length; i++) {
      loudSamples[i] = i % 2 === 0 ? 220 : 36
    }
    voiceMeter.nextTimeDomainSamples = loudSamples

    manual.flushFrame()
    expect(player.getVoiceLevel()).toBeCloseTo(0.45, 5)
    expect(player.getDuckGain()).toBeCloseTo(1 - 0.76 * 0.45, 5)

    // Subsequent loud frames push gain down to minDuckGain (0.24)
    for (let i = 0; i < 15; i++) {
      manual.flushFrame()
    }
    expect(player.getDuckGain()).toBeCloseTo(0.24, 3)

    // Releasing schedules a smooth linear ramp back to 1
    ctx.currentTime = 2.0
    player.releaseDuck()
    expect(manual.pendingCount).toBe(0)
    const duckGainNode = ctx.gainNodes[2]!
    expect(duckGainNode.gain.scheduled.at(-1)).toEqual({
      type: 'linearRamp',
      value: 1,
      endTime: 2.4,
    })
  })

  it('auto-releases sidechain when source ends and voice envelope settles', async () => {
    const ctx = new MockAudioContext()
    const manual = createManualScheduler()
    const player = createAudioDuckPlayer({
      createAudioContext: () => ctx as unknown as AudioContext,
      scheduler: manual.scheduler,
    })

    let ended = false
    const voiceNode = new MockAudioNode() as unknown as AudioNode
    player.sidechainNode(voiceNode, { isEnded: () => ended })
    const voiceMeter = ctx.analyserNodes[1]!
    voiceMeter.nextTimeDomainSamples = new Uint8Array(voiceMeter.fftSize).fill(128)

    ended = true
    manual.flushFrame()
    expect(manual.pendingCount).toBe(0)
    expect(player.getDuckGain()).toBe(1)
  })

  it('clamps duckHold and caches MediaElementAudioSourceNode per element', () => {
    const ctx = new MockAudioContext()
    const { scheduler } = createManualScheduler()
    const player = createAudioDuckPlayer({
      createAudioContext: () => ctx as unknown as AudioContext,
      scheduler,
    })

    player.duckHold(0.05)
    expect(player.getDuckGain()).toBe(0.2)

    player.duckHold(0.42)
    expect(player.getDuckGain()).toBe(0.42)

    const voiceEl = new MockAudioElement() as unknown as HTMLAudioElement
    player.sidechain(voiceEl)
    player.sidechain(voiceEl)
    expect(ctx.mediaSources).toHaveLength(1)
  })

  it('does not close an externally supplied AudioContext on dispose', async () => {
    const ctx = new MockAudioContext()
    const player = createAudioDuckPlayer({
      context: ctx as unknown as AudioContext,
    })

    player.init()
    await player.dispose()
    expect(ctx.closeCalls).toBe(0)
  })
})
