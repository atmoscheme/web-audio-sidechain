import {
  computeRmsFromByteTimeDomain,
  computeSpectrumEnergy,
  createEnvelopeTracker,
  DEFAULT_ENVELOPE_OPTIONS,
  downsampleSpectrum,
} from './envelope.js'
import type {
  AudioDuckPlayer,
  AudioDuckPlayerOptions,
  FrameScheduler,
  SidechainNodeOptions,
} from './types.js'

function createDefaultScheduler(): FrameScheduler {
  if (
    typeof globalThis.requestAnimationFrame === 'function' &&
    typeof globalThis.cancelAnimationFrame === 'function'
  ) {
    return {
      requestFrame: (cb) => globalThis.requestAnimationFrame(cb),
      cancelFrame: (id) => globalThis.cancelAnimationFrame(id),
    }
  }
  return {
    requestFrame: (cb) => globalThis.setTimeout(cb, 16) as unknown as number,
    cancelFrame: (id) => globalThis.clearTimeout(id),
  }
}

function createDefaultAudioContext(): AudioContext {
  const Ctor =
    globalThis.AudioContext ??
    (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) {
    throw new Error('Web Audio API AudioContext is not available in this environment.')
  }
  return new Ctor()
}

function createDefaultAudioElement(): HTMLAudioElement {
  if (typeof Audio === 'undefined') {
    throw new Error('HTMLAudioElement (Audio) is not available in this environment.')
  }
  return new Audio()
}

/**
 * Web Audio player with real-time RMS sidechain ducking.
 * Bed chain: bedInput -> gain -> duck -> bedAnalyser -> destination.
 * Voice key: source -> voiceMeter -> destination (RMS drives duck gain).
 */
export function createAudioDuckPlayer(
  options: AudioDuckPlayerOptions = {},
): AudioDuckPlayer {
  const scheduler = options.scheduler ?? createDefaultScheduler()
  const bedAnalyserFftSize = options.bedAnalyserFftSize ?? 256
  const bedAnalyserSmoothing = options.bedAnalyserSmoothing ?? 0.86
  const voiceAnalyserFftSize = options.voiceAnalyserFftSize ?? 1024
  const voiceAnalyserSmoothing = options.voiceAnalyserSmoothing ?? 0.35
  const releaseRampSeconds = Math.max(0.01, options.releaseRampSeconds ?? 0.4)
  const holdDuckFloor = Math.min(1, Math.max(0, options.holdDuckFloor ?? 0.2))
  const maxDuckGain = Math.min(
    1,
    Math.max(0, options.envelope?.maxDuckGain ?? DEFAULT_ENVELOPE_OPTIONS.maxDuckGain),
  )

  const envelope = createEnvelopeTracker(options.envelope)
  const ownsContext = !options.context

  let context: AudioContext | null = options.context ?? null
  let element: HTMLAudioElement | null = options.element ?? null
  let bedInput: GainNode | null = null
  let gain: GainNode | null = null
  let duck: GainNode | null = null
  let analyser: AnalyserNode | null = null
  let freqData: Uint8Array<ArrayBuffer> | null = null

  const elementSources = new WeakMap<HTMLAudioElement, MediaElementAudioSourceNode>()
  let bedElementConnected = false

  let voiceSource: AudioNode | null = null
  let voiceMeter: AnalyserNode | null = null
  let voiceData: Uint8Array<ArrayBuffer> | null = null
  let voiceEndedCheck: (() => boolean) | null = null
  let voiceFrame = 0
  let disposed = false

  function getOrCreateMediaSource(el: HTMLAudioElement, ctx: AudioContext): MediaElementAudioSourceNode {
    const existing = elementSources.get(el)
    if (existing) return existing
    const node = ctx.createMediaElementSource(el)
    elementSources.set(el, node)
    return node
  }

  function ensureElement(): HTMLAudioElement {
    if (!element) {
      element = options.createAudioElement
        ? options.createAudioElement()
        : createDefaultAudioElement()
      element.loop = false
      element.preload = 'auto'
    }
    return element
  }

  function ensureBedElementConnected(): void {
    if (!element || !context || !bedInput || bedElementConnected) return
    const mediaSource = getOrCreateMediaSource(element, context)
    mediaSource.connect(bedInput)
    bedElementConnected = true
  }

  function init(): AudioContext {
    if (disposed) {
      throw new Error('AudioDuckPlayer has been disposed.')
    }
    if (!context) {
      context = options.createAudioContext
        ? options.createAudioContext()
        : createDefaultAudioContext()
    }
    if (!bedInput) {
      bedInput = context.createGain()
      bedInput.gain.value = 1

      gain = context.createGain()
      gain.gain.value = 1

      duck = context.createGain()
      duck.gain.value = maxDuckGain

      analyser = context.createAnalyser()
      analyser.fftSize = bedAnalyserFftSize
      analyser.smoothingTimeConstant = bedAnalyserSmoothing

      bedInput.connect(gain)
      gain.connect(duck)
      duck.connect(analyser)
      analyser.connect(options.destination ?? context.destination)

      freqData = new Uint8Array(analyser.frequencyBinCount)
    }
    ensureBedElementConnected()
    return context
  }

  async function unlock(): Promise<AudioContext> {
    const ctx = init()
    if (ctx.state === 'suspended') {
      await ctx.resume()
    }
    return ctx
  }

  function setDuckImmediate(value: number): void {
    if (!duck || !context) return
    const now = context.currentTime
    duck.gain.cancelScheduledValues(now)
    duck.gain.setValueAtTime(value, now)
  }

  function clearVoice(): void {
    if (voiceFrame) {
      scheduler.cancelFrame(voiceFrame)
      voiceFrame = 0
    }
    voiceSource?.disconnect()
    voiceMeter?.disconnect()
    voiceSource = null
    voiceMeter = null
    voiceData = null
    voiceEndedCheck = null
    envelope.reset()
    if (!duck || !context) return
    const now = context.currentTime
    duck.gain.cancelScheduledValues(now)
    duck.gain.setValueAtTime(duck.gain.value, now)
    duck.gain.linearRampToValueAtTime(maxDuckGain, now + releaseRampSeconds)
  }

  function followVoice(): void {
    if (!voiceMeter || !voiceData || !duck || !context) return
    voiceMeter.getByteTimeDomainData(voiceData)
    const rms = computeRmsFromByteTimeDomain(voiceData)
    const { level, duckGain } = envelope.step(rms)
    setDuckImmediate(duckGain)
    if (voiceEndedCheck?.() && level < 0.02) {
      clearVoice()
    }
  }

  function sidechainNode(node: AudioNode, nodeOptions: SidechainNodeOptions = {}): void {
    const ctx = init()
    clearVoice()
    if (ctx.state === 'suspended') {
      void ctx.resume()
    }
    voiceSource = node
    voiceMeter = ctx.createAnalyser()
    voiceMeter.fftSize = voiceAnalyserFftSize
    voiceMeter.smoothingTimeConstant = voiceAnalyserSmoothing
    voiceSource.connect(voiceMeter)
    voiceMeter.connect(options.destination ?? ctx.destination)
    voiceData = new Uint8Array(voiceMeter.fftSize)
    voiceEndedCheck = nodeOptions.isEnded ?? null
    envelope.reset()

    const tick = () => {
      if (!voiceMeter) return
      voiceFrame = scheduler.requestFrame(tick)
      followVoice()
    }
    voiceFrame = scheduler.requestFrame(tick)
  }

  function sidechain(voiceElement: HTMLAudioElement): void {
    const ctx = init()
    const mediaNode = getOrCreateMediaSource(voiceElement, ctx)
    sidechainNode(mediaNode, {
      isEnded: () => voiceElement.ended,
    })
  }

  function duckHold(amount: number): void {
    init()
    clearVoice()
    setDuckImmediate(Math.min(maxDuckGain, Math.max(holdDuckFloor, amount)))
  }

  function releaseDuck(): void {
    clearVoice()
  }

  function preload(src: string): void {
    const el = ensureElement()
    if (el.src && el.getAttribute('src') === src) return
    el.src = src
    el.load()
  }

  function setGain(value: number): void {
    if (!gain || !context) return
    const now = context.currentTime
    gain.gain.cancelScheduledValues(now)
    gain.gain.setValueAtTime(value, now)
  }

  function resetGain(): void {
    setGain(1)
  }

  function setTrack(src: string): void {
    resetGain()
    preload(src)
  }

  async function seek(seconds: number): Promise<void> {
    const el = ensureElement()
    if (!Number.isFinite(el.duration) || el.duration === 0) {
      await new Promise<void>((resolve, reject) => {
        const done = () => {
          el.removeEventListener('loadedmetadata', done)
          el.removeEventListener('error', fail)
          resolve()
        }
        const fail = () => {
          el.removeEventListener('loadedmetadata', done)
          el.removeEventListener('error', fail)
          reject(new Error('Failed to load audio metadata for seek.'))
        }
        el.addEventListener('loadedmetadata', done)
        el.addEventListener('error', fail)
      })
    }
    const end = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : seconds
    el.currentTime = Math.min(Math.max(0, seconds), end)
  }

  async function play(): Promise<void> {
    ensureElement()
    await unlock()
    await element!.play()
  }

  function pause(): void {
    element?.pause()
    resetGain()
  }

  function fadeIn(ms: number): void {
    const ctx = init()
    if (!gain) return
    const now = ctx.currentTime
    const dur = Math.max(0.05, ms / 1000)
    gain.gain.cancelScheduledValues(now)
    gain.gain.setValueAtTime(0, now)
    gain.gain.linearRampToValueAtTime(1, now + dur)
  }

  function setVolume(value: number): void {
    if (element) {
      element.volume = Math.min(1, Math.max(0, value))
    }
  }

  function setMuted(muted: boolean): void {
    if (element) {
      element.muted = muted
    }
  }

  function getEnergy(): number {
    if (!analyser || !freqData) return 0
    analyser.getByteFrequencyData(freqData)
    return computeSpectrumEnergy(freqData)
  }

  function getSpectrum(bins = 24): number[] {
    if (!analyser || !freqData) {
      return Array.from({ length: Math.max(0, Math.floor(bins)) }, () => 0)
    }
    analyser.getByteFrequencyData(freqData)
    return downsampleSpectrum(freqData, bins)
  }

  async function dispose(): Promise<void> {
    if (disposed) return
    disposed = true
    if (voiceFrame) {
      scheduler.cancelFrame(voiceFrame)
      voiceFrame = 0
    }
    voiceSource?.disconnect()
    voiceMeter?.disconnect()
    voiceSource = null
    voiceMeter = null
    voiceData = null
    voiceEndedCheck = null
    envelope.reset()

    if (element) {
      element.pause()
      const elSource = elementSources.get(element)
      elSource?.disconnect()
    }
    bedInput?.disconnect()
    gain?.disconnect()
    duck?.disconnect()
    analyser?.disconnect()

    bedInput = null
    gain = null
    duck = null
    analyser = null
    freqData = null
    bedElementConnected = false

    if (ownsContext && context && context.state !== 'closed') {
      await context.close()
    }
    context = null
  }

  return {
    init,
    unlock,
    getContext: () => context,
    getBedInput: () => {
      init()
      return bedInput!
    },
    preload,
    setTrack,
    seek,
    play,
    pause,
    setGain,
    resetGain,
    fadeIn,
    setVolume,
    setMuted,
    sidechain,
    sidechainNode,
    duckHold,
    releaseDuck,
    getEnergy,
    getSpectrum,
    getDuckGain: () => duck?.gain.value ?? maxDuckGain,
    getVoiceLevel: () => envelope.level,
    get currentTime() {
      return element?.currentTime ?? 0
    },
    get duration() {
      return element?.duration || 0
    },
    get ended() {
      return Boolean(element?.ended)
    },
    get state() {
      return context ? context.state : 'uninitialized'
    },
    dispose,
  }
}
