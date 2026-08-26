import type { ProceduralClick, ProceduralClickOptions } from './types.js'

function createDefaultAudioContext(): AudioContext {
  const Ctor =
    globalThis.AudioContext ??
    (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) {
    throw new Error('Web Audio API AudioContext is not available in this environment.')
  }
  return new Ctor()
}

/**
 * Create a zero-asset procedural UI click synthesizer using a short decaying OscillatorNode.
 */
export function createProceduralClick(
  options: ProceduralClickOptions = {},
): ProceduralClick {
  const ownsContext = !options.context
  const frequency = options.frequency ?? 1480
  const waveform = options.waveform ?? 'square'
  const gainAmount = options.gain ?? 0.028
  const durationSeconds = Math.max(0.005, options.durationSeconds ?? 0.03)
  const minIntervalMs = Math.max(0, options.minIntervalMs ?? 28)
  const nowFn = options.now ?? (() => performance.now())

  let context: AudioContext | null = options.context ?? null
  let lastClickMs = Number.NEGATIVE_INFINITY
  let disposed = false

  function ensureContext(): AudioContext {
    if (disposed) {
      throw new Error('ProceduralClick has been disposed.')
    }
    if (!context) {
      context = options.createAudioContext
        ? options.createAudioContext()
        : createDefaultAudioContext()
    }
    return context
  }

  async function unlock(): Promise<AudioContext> {
    const ctx = ensureContext()
    if (ctx.state === 'suspended') {
      await ctx.resume()
    }
    return ctx
  }

  async function click(): Promise<boolean> {
    const now = nowFn()
    if (now - lastClickMs < minIntervalMs) {
      return false
    }
    lastClickMs = now

    const ctx = await unlock()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()

    osc.type = waveform
    osc.frequency.value = frequency

    const t = ctx.currentTime
    gain.gain.setValueAtTime(gainAmount, t)
    gain.gain.exponentialRampToValueAtTime(0.0001, t + durationSeconds)

    osc.connect(gain)
    gain.connect(options.destination ?? ctx.destination)

    osc.start(t)
    osc.stop(t + durationSeconds + 0.002)
    return true
  }

  async function dispose(): Promise<void> {
    if (disposed) return
    disposed = true
    if (ownsContext && context && context.state !== 'closed') {
      await context.close()
    }
    context = null
  }

  return {
    unlock,
    click,
    dispose,
  }
}
