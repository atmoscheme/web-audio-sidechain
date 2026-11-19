export { createAudioDuckPlayer } from './duckPlayer.js'
export {
  computeRmsFromByteTimeDomain,
  computeRmsFromFloatTimeDomain,
  computeSpectrumEnergy,
  createEnvelopeTracker,
  DEFAULT_ENVELOPE_OPTIONS,
  downsampleSpectrum,
} from './envelope.js'
export { createSidechainNarrator, estimateSpeechMs } from './narrator.js'
export { createProceduralClick } from './proceduralClick.js'
export type {
  AudioDuckPlayer,
  AudioDuckPlayerOptions,
  EnvelopeOptions,
  EnvelopeStepResult,
  EnvelopeTracker,
  FrameScheduler,
  ProceduralClick,
  ProceduralClickOptions,
  SidechainNarrator,
  SidechainNarratorOptions,
  SidechainNodeOptions,
  SpeakOptions,
  SpeechBeat,
  TtsProvider,
} from './types.js'
