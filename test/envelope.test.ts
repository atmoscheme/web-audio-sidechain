import { describe, expect, it } from 'vitest'
import {
  computeRmsFromByteTimeDomain,
  computeRmsFromFloatTimeDomain,
  computeSpectrumEnergy,
  createEnvelopeTracker,
  downsampleSpectrum,
} from '../src/envelope.js'

describe('envelope & RMS math', () => {
  it('computes 0 RMS for silence (128 centered byte samples) and empty arrays', () => {
    expect(computeRmsFromByteTimeDomain([])).toBe(0)
    expect(computeRmsFromByteTimeDomain(new Uint8Array(256).fill(128))).toBe(0)
    expect(computeRmsFromFloatTimeDomain([])).toBe(0)
    expect(computeRmsFromFloatTimeDomain(new Float32Array(64).fill(0))).toBe(0)
  })

  it('computes exact RMS for non-silent byte and float samples', () => {
    // 128 + 64 = 192 (+0.5) and 128 - 64 = 64 (-0.5) give RMS = 0.5
    const bytes = new Uint8Array([192, 64, 192, 64])
    expect(computeRmsFromByteTimeDomain(bytes)).toBeCloseTo(0.5, 6)

    const floats = new Float32Array([0.5, -0.5, 0.5, -0.5])
    expect(computeRmsFromFloatTimeDomain(floats)).toBeCloseTo(0.5, 6)
  })

  it('ignores RMS below noiseFloor and ducks progressively above it', () => {
    const tracker = createEnvelopeTracker()

    const silent = tracker.step(0.01)
    expect(silent.level).toBe(0)
    expect(silent.duckGain).toBe(1)

    // Full voice RMS >= noiseFloor (0.018) + rmsRange (0.16) = 0.178 gives targetLevel = 1
    const attack1 = tracker.step(0.25)
    expect(attack1.level).toBeCloseTo(0.45, 6)
    expect(attack1.duckGain).toBeCloseTo(1 - 0.76 * 0.45, 6)

    // Repeated loud frames converge toward minDuckGain (0.24)
    for (let i = 0; i < 20; i++) {
      tracker.step(0.25)
    }
    expect(tracker.level).toBeGreaterThan(0.99)
    expect(tracker.duckGain).toBeCloseTo(0.24, 3)

    // Release is slower than attack (0.08 vs 0.45)
    const afterOneSilent = tracker.step(0)
    expect(afterOneSilent.level).toBeGreaterThan(0.9)
    expect(afterOneSilent.duckGain).toBeLessThan(0.32)

    tracker.reset()
    expect(tracker.level).toBe(0)
    expect(tracker.duckGain).toBe(1)
  })

  it('computes normalized spectrum energy and downsampled bins', () => {
    expect(computeSpectrumEnergy([])).toBe(0)
    expect(computeSpectrumEnergy(new Uint8Array([0, 255, 0, 255]))).toBeCloseTo(0.5, 6)

    const bins = new Uint8Array([255, 255, 128, 128, 0, 0, 64, 64])
    const downsampled = downsampleSpectrum(bins, 4)
    expect(downsampled).toHaveLength(4)
    expect(downsampled[0]).toBeCloseTo(1, 5)
    expect(downsampled[1]).toBeCloseTo(128 / 255, 5)
    expect(downsampled[2]).toBe(0)
    expect(downsampled[3]).toBeCloseTo(64 / 255, 5)
  })
})
