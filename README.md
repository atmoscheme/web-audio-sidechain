# web-audio-sidechain

Web Audio API sidechain ducking for background audio under TTS narration, extracted from the audio engine in [atmoscheme.com](https://atmoscheme.com).

When a voice line plays, `createAudioDuckPlayer` reads its time-domain signal through an `AnalyserNode` (`fftSize = 1024`), computes RMS amplitude, and drives a background `GainNode` through an asymmetric attack/release envelope (`attackSmoothing: 0.45`, `releaseSmoothing: 0.08`). If no `ttsProvider` is configured or a request fails, `createSidechainNarrator` falls back to `window.speechSynthesis` and holds a steady `duckHold` gain (`0.42`) until the utterance ends.

```bash
npm install web-audio-sidechain
```

## Background track + TTS endpoint

```ts
import { createAudioDuckPlayer, createSidechainNarrator } from 'web-audio-sidechain'

const player = createAudioDuckPlayer()
const narrator = createSidechainNarrator({
  player,
  locale: 'en-US',
  ttsProvider: async (text, signal) => {
    const res = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      signal,
    })
    if (!res.ok) throw new Error(`TTS failed: ${res.status}`)
    return res.arrayBuffer()
  },
})

playButton.addEventListener('click', async () => {
  await player.unlock()
  player.setTrack('/ambient.ogg')
  player.fadeIn(1200)
  await player.play()

  await narrator.speak('Welcome aboard. Telemetry nominal.')
  void narrator.enqueue('Segment one complete.')
  void narrator.enqueue('Proceeding to segment two.')
})
```

## Procedural bed + `speechSynthesis` fallback

You can also connect any Web Audio source (oscillators, samplers, synths) to `player.getBedInput()`, and omit `ttsProvider` to use the browser's `speechSynthesis`:

```ts
import { createAudioDuckPlayer, createSidechainNarrator } from 'web-audio-sidechain'

const player = createAudioDuckPlayer()
const narrator = createSidechainNarrator({ player, locale: 'en-US' })

startButton.addEventListener('click', async () => {
  const ctx = await player.unlock()
  const osc = ctx.createOscillator()
  const padGain = ctx.createGain()
  padGain.gain.value = 0.15

  osc.type = 'triangle'
  osc.frequency.value = 110
  osc.connect(padGain)
  padGain.connect(player.getBedInput())
  osc.start()

  await narrator.speak('Using browser speech synthesis with steady ducking.')
})
```

Browsers start `AudioContext` in `'suspended'` state outside user gestures. `warm()` and `decodeAudioData` still work beforehand, while `player.unlock()`, `player.play()`, and playback start resume the context.

## Exports

- `createAudioDuckPlayer(options?)`: `init`, `unlock`, `getBedInput`, `preload`, `setTrack`, `seek`, `play`, `pause`, `fadeIn`, `setGain`, `resetGain`, `setVolume`, `setMuted`, `sidechain`, `sidechainNode`, `duckHold`, `releaseDuck`, `getEnergy`, `getSpectrum`, `getDuckGain`, `getVoiceLevel`, `dispose`. Pass an external `context` if you manage `AudioContext` lifecycle yourself (`dispose()` leaves external contexts open).
- `createSidechainNarrator(options?)`: `warm`, `speak`, `enqueue`, `clearQueue`, `stop`, `dispose`, `estimateDurationMs`, `queueLength`, `isSpeaking`.
- `createProceduralClick(options?)`: short decaying `OscillatorNode` UI click with debouncing (`minIntervalMs: 28`).
- Envelope and spectrum helpers: `createEnvelopeTracker`, `computeRmsFromByteTimeDomain`, `computeRmsFromFloatTimeDomain`, `computeSpectrumEnergy`, `downsampleSpectrum`, `estimateSpeechMs`.

## Demo and scripts

A local Vite demo (`examples/vite-demo`) synthesizes both a Web Audio chord and an in-memory PCM WAV voice track with no external audio files:

```bash
npm install
npm run build
npm --prefix examples/vite-demo install
npm --prefix examples/vite-demo run dev
```

Checks: `npm run typecheck`, `npm test`, `npm run build`, `npm run demo:build`.

MIT
