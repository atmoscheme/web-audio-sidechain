import {
  createAudioDuckPlayer,
  createProceduralClick,
  createSidechainNarrator,
  type TtsProvider,
} from 'web-audio-sidechain'
import './style.css'

/**
 * Synthesize an in-memory mono 16-bit PCM WAV buffer with syllable bursts
 * so the demo exercises ttsProvider, decodeAudioData, and RMS sidechain
 * without bundling audio files.
 */
function synthesizeProceduralSpeechWav(text: string): ArrayBuffer {
  const sampleRate = 22050
  const durationSec = Math.min(4.5, Math.max(1.2, text.trim().length * 0.045))
  const numSamples = Math.floor(sampleRate * durationSec)
  const dataBytes = numSamples * 2
  const buffer = new ArrayBuffer(44 + dataBytes)
  const view = new DataView(buffer)

  const writeAscii = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i))
    }
  }

  writeAscii(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  writeAscii(8, 'WAVE')
  writeAscii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeAscii(36, 'data')
  view.setUint32(40, dataBytes, true)

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate
    // Modulated syllable cadence (~4.5 Hz) over a warm fundamental + formant harmonics
    const syllableGate = Math.max(0, Math.sin(2 * Math.PI * 4.2 * t))
    const env = Math.pow(syllableGate, 0.7) * Math.min(1, t * 12) * Math.min(1, (durationSec - t) * 8)
    const f0 = 155 + 22 * Math.sin(2 * Math.PI * 1.4 * t)
    const sample =
      env *
      (0.45 * Math.sin(2 * Math.PI * f0 * t) +
        0.25 * Math.sin(2 * Math.PI * f0 * 2.5 * t) +
        0.12 * Math.sin(2 * Math.PI * f0 * 4.1 * t))
    const clamped = Math.max(-1, Math.min(1, sample))
    view.setInt16(44 + i * 2, Math.round(clamped * 32767), true)
  }

  return buffer
}

const proceduralTtsProvider: TtsProvider = async (text, signal) => {
  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(resolve, 60)
    signal?.addEventListener(
      'abort',
      () => {
        window.clearTimeout(timer)
        reject(new DOMException('Aborted', 'AbortError'))
      },
      { once: true },
    )
  })
  return synthesizeProceduralSpeechWav(text)
}

const player = createAudioDuckPlayer()
const narrator = createSidechainNarrator({
  player,
  ttsProvider: proceduralTtsProvider,
})
const fallbackNarrator = createSidechainNarrator({
  player,
  locale: 'en-US',
})
const clicker = createProceduralClick()

let ambientStopper: (() => void) | null = null

function startAmbient(): void {
  if (ambientStopper) return
  const ctx = player.init()
  void player.unlock()
  const bedInput = player.getBedInput()

  const filter = ctx.createBiquadFilter()
  filter.type = 'lowpass'
  filter.frequency.value = 620
  filter.Q.value = 1.4

  const master = ctx.createGain()
  master.gain.value = 0.22
  filter.connect(master)
  master.connect(bedInput)

  const freqs = [110, 164.81, 220, 277.18]
  const oscs = freqs.map((freq, idx) => {
    const osc = ctx.createOscillator()
    osc.type = idx % 2 === 0 ? 'sawtooth' : 'triangle'
    osc.frequency.value = freq
    osc.connect(filter)
    osc.start()
    return osc
  })

  const lfo = ctx.createOscillator()
  const lfoGain = ctx.createGain()
  lfo.frequency.value = 0.14
  lfoGain.gain.value = 260
  lfo.connect(lfoGain)
  lfoGain.connect(filter.frequency)
  lfo.start()

  ambientStopper = () => {
    for (const osc of oscs) {
      osc.stop()
      osc.disconnect()
    }
    lfo.stop()
    lfo.disconnect()
    lfoGain.disconnect()
    filter.disconnect()
    master.disconnect()
    ambientStopper = null
  }
}

const toggleBtn = document.getElementById('toggle-ambient') as HTMLButtonElement
const speakTtsBtn = document.getElementById('speak-tts') as HTMLButtonElement
const enqueueBtn = document.getElementById('enqueue-three') as HTMLButtonElement
const speakFallbackBtn = document.getElementById('speak-fallback') as HTMLButtonElement
const clearQueueBtn = document.getElementById('clear-queue') as HTMLButtonElement
const stopSpeechBtn = document.getElementById('stop-speech') as HTMLButtonElement
const textInput = document.getElementById('narration-text') as HTMLInputElement

const duckBar = document.getElementById('duck-bar') as HTMLDivElement
const voiceBar = document.getElementById('voice-bar') as HTMLDivElement
const duckValue = document.getElementById('duck-value') as HTMLElement
const voiceValue = document.getElementById('voice-value') as HTMLElement
const statusText = document.getElementById('status-text') as HTMLElement
const spectrumEl = document.getElementById('spectrum') as HTMLDivElement

const bars = Array.from({ length: 24 }, () => {
  const bar = document.createElement('div')
  bar.className = 'spectrum-bar'
  bar.style.height = '4%'
  spectrumEl.appendChild(bar)
  return bar
})

toggleBtn.addEventListener('click', () => {
  void clicker.click()
  if (ambientStopper) {
    ambientStopper()
    toggleBtn.textContent = 'Start Procedural Ambient'
  } else {
    startAmbient()
    toggleBtn.textContent = 'Stop Procedural Ambient'
  }
})

speakTtsBtn.addEventListener('click', () => {
  void clicker.click()
  void player.unlock()
  fallbackNarrator.stop()
  void narrator.speak(textInput.value)
})

enqueueBtn.addEventListener('click', () => {
  void clicker.click()
  void player.unlock()
  fallbackNarrator.stop()
  void narrator.enqueue('Segment one: initializing orbital guidance.')
  void narrator.enqueue('Segment two: sidechain envelope tracking active.')
  void narrator.enqueue('Segment three: returning ambient bed to full level.')
})

speakFallbackBtn.addEventListener('click', () => {
  void clicker.click()
  void player.unlock()
  narrator.stop()
  void fallbackNarrator.speak(textInput.value)
})

clearQueueBtn.addEventListener('click', () => {
  void clicker.click()
  narrator.clearQueue()
  fallbackNarrator.clearQueue()
})

stopSpeechBtn.addEventListener('click', () => {
  void clicker.click()
  narrator.stop()
  fallbackNarrator.stop()
})

function renderMeters(): void {
  const duck = player.getDuckGain()
  const voice = player.getVoiceLevel()
  const spectrum = player.getSpectrum(24)

  duckBar.style.width = `${Math.round(duck * 100)}%`
  voiceBar.style.width = `${Math.round(voice * 100)}%`
  duckValue.textContent = duck.toFixed(2)
  voiceValue.textContent = voice.toFixed(2)

  const speaking = narrator.isSpeaking || fallbackNarrator.isSpeaking
  statusText.textContent = `${speaking ? 'speaking' : 'idle'} · queue: ${narrator.queueLength}`

  for (let i = 0; i < bars.length; i++) {
    const level = spectrum[i] ?? 0
    bars[i]!.style.height = `${Math.max(4, Math.round(level * 100))}%`
  }
  window.requestAnimationFrame(renderMeters)
}

window.requestAnimationFrame(renderMeters)
