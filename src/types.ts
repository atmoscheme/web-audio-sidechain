export interface EnvelopeOptions {
  /** Normalized RMS threshold below which voice is treated as silence (default 0.018). */
  noiseFloor?: number
  /** Normalized RMS span above `noiseFloor` mapped to [0, 1] level (default 0.16). */
  rmsRange?: number
  attackSmoothing?: number
  releaseSmoothing?: number
  minDuckGain?: number
  maxDuckGain?: number
}

export interface EnvelopeStepResult {
  level: number
  duckGain: number
}

export interface EnvelopeTracker {
  step(rms: number): EnvelopeStepResult
  reset(): void
  readonly level: number
  readonly duckGain: number
}

export interface FrameScheduler {
  requestFrame: (callback: () => void) => number
  cancelFrame: (id: number) => void
}

export interface AudioDuckPlayerOptions {
  /** Externally-owned AudioContext; `dispose()` will not close it. */
  context?: AudioContext
  createAudioContext?: () => AudioContext
  element?: HTMLAudioElement
  createAudioElement?: () => HTMLAudioElement
  destination?: AudioNode
  bedAnalyserFftSize?: number
  bedAnalyserSmoothing?: number
  voiceAnalyserFftSize?: number
  voiceAnalyserSmoothing?: number
  releaseRampSeconds?: number
  holdDuckFloor?: number
  envelope?: EnvelopeOptions
  scheduler?: FrameScheduler
}

export interface SidechainNodeOptions {
  /** Checked each frame; releases ducking when true and envelope falls below 0.02. */
  isEnded?: () => boolean
}

export interface AudioDuckPlayer {
  init(): AudioContext
  unlock(): Promise<AudioContext>
  getContext(): AudioContext | null
  /** Returns the bed GainNode entry point for procedural sources (oscillators, buffers). */
  getBedInput(): GainNode
  preload(src: string): void
  setTrack(src: string): void
  seek(seconds: number): Promise<void>
  play(): Promise<void>
  pause(): void
  setGain(value: number): void
  resetGain(): void
  fadeIn(ms: number): void
  setVolume(value: number): void
  setMuted(muted: boolean): void
  sidechain(element: HTMLAudioElement): void
  sidechainNode(node: AudioNode, options?: SidechainNodeOptions): void
  /** Hold a steady duck gain when speech exposes no audio samples (SpeechSynthesis). */
  duckHold(amount: number): void
  releaseDuck(): void
  getEnergy(): number
  getSpectrum(bins?: number): number[]
  getDuckGain(): number
  getVoiceLevel(): number
  readonly currentTime: number
  readonly duration: number
  readonly ended: boolean
  readonly state: AudioContextState | 'uninitialized'
  dispose(): Promise<void>
}

export type TtsProvider = (
  text: string,
  signal?: AbortSignal,
) => Promise<Blob | ArrayBuffer>

export interface SpeakOptions {
  locale?: string
}

export interface SpeechBeat {
  durationMs: number
  fallback: boolean
  play: () => void
  stop: () => void
  finished: Promise<void>
}

export interface SidechainNarratorOptions {
  player?: AudioDuckPlayer
  playerOptions?: AudioDuckPlayerOptions
  /** Custom TTS audio fetcher; falls back to `speechSynthesis` if omitted or on error. */
  ttsProvider?: TtsProvider
  locale?: string
  fallbackDuckAmount?: number
  fallbackMsPerChar?: number
  minFallbackMs?: number
  speechSynthesisFallback?: boolean
  speechSynthesis?: SpeechSynthesis | null
  Utterance?: typeof SpeechSynthesisUtterance
}

export interface SidechainNarrator {
  readonly player: AudioDuckPlayer
  readonly queueLength: number
  readonly isSpeaking: boolean
  estimateDurationMs(text: string): number
  warm(text: string, options?: SpeakOptions): Promise<SpeechBeat | null>
  /** Interrupt active speech and clear queue, then play `text`. */
  speak(text: string, options?: SpeakOptions): Promise<SpeechBeat | null>
  /** Append to sequential queue; resolves with its beat when its turn starts, or null if cancelled. */
  enqueue(text: string, options?: SpeakOptions): Promise<SpeechBeat | null>
  clearQueue(): void
  stop(): void
  dispose(): Promise<void>
}

export interface ProceduralClickOptions {
  /** Externally-owned AudioContext; `dispose()` will not close it. */
  context?: AudioContext
  createAudioContext?: () => AudioContext
  destination?: AudioNode
  frequency?: number
  waveform?: OscillatorType
  gain?: number
  durationSeconds?: number
  minIntervalMs?: number
  now?: () => number
}

export interface ProceduralClick {
  unlock(): Promise<AudioContext>
  click(): Promise<boolean>
  dispose(): Promise<void>
}
