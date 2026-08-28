import type { EnvelopeOptions, EnvelopeStepResult, EnvelopeTracker } from './types.js'

export const DEFAULT_ENVELOPE_OPTIONS: Required<EnvelopeOptions> = {
  noiseFloor: 0.018,
  rmsRange: 0.16,
  attackSmoothing: 0.45,
  releaseSmoothing: 0.08,
  minDuckGain: 0.24,
  maxDuckGain: 1,
}

/**
 * Compute root-mean-square amplitude from 8-bit unsigned time-domain samples (`0..255`, centered at `128`).
 */
export function computeRmsFromByteTimeDomain(samples: ArrayLike<number>): number {
  const len = samples.length
  if (len === 0) return 0
  let sum = 0
  for (let i = 0; i < len; i++) {
    const sample = samples[i] ?? 128
    const normalized = (sample - 128) / 128
    sum += normalized * normalized
  }
  return Math.sqrt(sum / len)
}

/**
 * Compute root-mean-square amplitude from normalized float time-domain samples (`-1..1`).
 */
export function computeRmsFromFloatTimeDomain(samples: ArrayLike<number>): number {
  const len = samples.length
  if (len === 0) return 0
  let sum = 0
  for (let i = 0; i < len; i++) {
    const sample = samples[i] ?? 0
    sum += sample * sample
  }
  return Math.sqrt(sum / len)
}

/**
 * Compute mean normalized `[0, 1]` energy from 8-bit frequency bin data.
 */
export function computeSpectrumEnergy(bins: ArrayLike<number>): number {
  const len = bins.length
  if (len === 0) return 0
  let sum = 0
  for (let i = 0; i < len; i++) {
    sum += bins[i] ?? 0
  }
  return sum / len / 255
}

/**
 * Downsample 8-bit frequency bins into `targetBins` normalized `[0, 1]` values.
 */
export function downsampleSpectrum(bins: ArrayLike<number>, targetBins = 24): number[] {
  const count = Math.max(0, Math.floor(targetBins))
  if (count === 0) return []
  const len = bins.length
  if (len === 0) return Array.from({ length: count }, () => 0)
  const slice = Math.floor(len / count)
  if (slice <= 0) {
    return Array.from({ length: count }, (_, i) => (bins[i] ?? 0) / 255)
  }
  return Array.from({ length: count }, (_, i) => {
    let sum = 0
    for (let j = 0; j < slice; j++) {
      sum += bins[i * slice + j] ?? 0
    }
    return sum / slice / 255
  })
}

/**
 * Create an RMS-to-duck-gain envelope follower with asymmetric attack and release smoothing.
 */
export function createEnvelopeTracker(options: EnvelopeOptions = {}): EnvelopeTracker {
  const noiseFloor = options.noiseFloor ?? DEFAULT_ENVELOPE_OPTIONS.noiseFloor
  const rmsRange = Math.max(1e-6, options.rmsRange ?? DEFAULT_ENVELOPE_OPTIONS.rmsRange)
  const attackSmoothing = clamp01(options.attackSmoothing ?? DEFAULT_ENVELOPE_OPTIONS.attackSmoothing)
  const releaseSmoothing = clamp01(options.releaseSmoothing ?? DEFAULT_ENVELOPE_OPTIONS.releaseSmoothing)
  const maxDuckGain = clamp01(options.maxDuckGain ?? DEFAULT_ENVELOPE_OPTIONS.maxDuckGain)
  const minDuckGain = Math.min(
    maxDuckGain,
    clamp01(options.minDuckGain ?? DEFAULT_ENVELOPE_OPTIONS.minDuckGain),
  )
  const duckRange = maxDuckGain - minDuckGain

  let voiceLevel = 0
  let currentDuckGain = maxDuckGain

  return {
    step(rms: number): EnvelopeStepResult {
      const targetLevel = clamp01((rms - noiseFloor) / rmsRange)
      const smoothing = targetLevel > voiceLevel ? attackSmoothing : releaseSmoothing
      voiceLevel += (targetLevel - voiceLevel) * smoothing
      currentDuckGain = Math.max(minDuckGain, maxDuckGain - duckRange * voiceLevel)
      return {
        level: voiceLevel,
        duckGain: currentDuckGain,
      }
    },
    reset() {
      voiceLevel = 0
      currentDuckGain = maxDuckGain
    },
    get level() {
      return voiceLevel
    },
    get duckGain() {
      return currentDuckGain
    },
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}
