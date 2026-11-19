import { createAudioDuckPlayer } from './duckPlayer.js'
import type {
  SidechainNarrator,
  SidechainNarratorOptions,
  SpeakOptions,
  SpeechBeat,
} from './types.js'

const DEFAULT_FALLBACK_MS_PER_CHAR = 70
const DEFAULT_MIN_FALLBACK_MS = 1200
const DEFAULT_FALLBACK_DUCK_AMOUNT = 0.42

interface SynthesizedEntry {
  buffer: AudioBuffer | null
  durationMs: number
  fallback: boolean
  spoken: string
  locale: string
}

interface QueueItem {
  text: string
  locale: string
  controller: AbortController
  cancelled: boolean
  resolve: (beat: SpeechBeat | null) => void
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: unknown }).name === 'AbortError'
  )
}

function normalizeLocale(locale: string): string {
  const trimmed = locale.trim()
  return trimmed || 'en'
}

/**
 * Estimate speech duration in milliseconds from text length.
 */
export function estimateSpeechMs(
  text: string,
  msPerChar = DEFAULT_FALLBACK_MS_PER_CHAR,
  minMs = DEFAULT_MIN_FALLBACK_MS,
): number {
  const length = text.trim().length
  return Math.max(minMs, Math.round(length * msPerChar))
}

/**
 * Create an instantiable sidechain narrator that coordinates TTS synthesis,
 * sequential queueing, cancellation, real-time RMS ducking, and SpeechSynthesis fallback.
 */
export function createSidechainNarrator(
  options: SidechainNarratorOptions = {},
): SidechainNarrator {
  const ownsPlayer = !options.player
  const player = options.player ?? createAudioDuckPlayer(options.playerOptions)
  const defaultLocale = normalizeLocale(options.locale ?? 'en')
  const fallbackDuckAmount = options.fallbackDuckAmount ?? DEFAULT_FALLBACK_DUCK_AMOUNT
  const fallbackMsPerChar = options.fallbackMsPerChar ?? DEFAULT_FALLBACK_MS_PER_CHAR
  const minFallbackMs = options.minFallbackMs ?? DEFAULT_MIN_FALLBACK_MS
  const allowFallback = options.speechSynthesisFallback ?? true

  let generation = 0
  let activeBeat: SpeechBeat | null = null
  let activeSynthesisController: AbortController | null = null
  let disposed = false

  const waiting = new Map<string, Promise<SynthesizedEntry | null>>()
  const cache = new Map<string, SynthesizedEntry>()
  let warmChain: Promise<void> = Promise.resolve()

  const queue: QueueItem[] = []
  let draining = false

  function getSpeechSynthesis(): SpeechSynthesis | null {
    if (options.speechSynthesis !== undefined) {
      return options.speechSynthesis
    }
    return typeof globalThis.speechSynthesis !== 'undefined'
      ? globalThis.speechSynthesis
      : null
  }

  function getUtteranceCtor(): typeof SpeechSynthesisUtterance | null {
    if (options.Utterance !== undefined) {
      return options.Utterance
    }
    return typeof globalThis.SpeechSynthesisUtterance !== 'undefined'
      ? globalThis.SpeechSynthesisUtterance
      : null
  }

  function keyOf(text: string, locale: string): string {
    return `${normalizeLocale(locale).toLowerCase()}\n${text.trim()}`
  }

  function createBeat(entry: SynthesizedEntry): SpeechBeat {
    let source: AudioBufferSourceNode | null = null
    let stopped = false
    let played = false
    let settled = false
    let resolveFinished!: () => void
    const finished = new Promise<void>((resolve) => {
      resolveFinished = resolve
    })

    const settle = () => {
      if (settled) return
      settled = true
      resolveFinished()
    }

    const play = () => {
      if (stopped || played) return
      played = true

      if (entry.buffer) {
        const ctx = player.init()
        if (ctx.state === 'suspended') {
          void ctx.resume()
        }
        const bufferSource = ctx.createBufferSource()
        bufferSource.buffer = entry.buffer
        source = bufferSource
        let ended = false
        bufferSource.onended = () => {
          ended = true
          if (!stopped) {
            player.releaseDuck()
          }
          settle()
        }
        player.sidechainNode(bufferSource, {
          isEnded: () => ended || stopped,
        })
        bufferSource.start(0)
        return
      }

      const synth = getSpeechSynthesis()
      const UtteranceCtor = getUtteranceCtor()
      if (!allowFallback || !synth || !UtteranceCtor || !entry.spoken) {
        settle()
        return
      }

      const utter = new UtteranceCtor(entry.spoken)
      utter.lang = entry.locale
      utter.onend = () => {
        if (!stopped) {
          player.releaseDuck()
        }
        settle()
      }
      utter.onerror = () => {
        if (!stopped) {
          player.releaseDuck()
        }
        settle()
      }
      player.duckHold(fallbackDuckAmount)
      synth.cancel()
      synth.speak(utter)
    }

    const stop = () => {
      if (stopped) return
      stopped = true
      if (source) {
        try {
          source.stop()
        } catch {
          // AudioBufferSourceNode may not have started or already stopped.
        }
        try {
          source.disconnect()
        } catch {
          // Ignore disconnect errors on already disposed nodes.
        }
        source = null
      }
      player.releaseDuck()
      if (entry.fallback) {
        getSpeechSynthesis()?.cancel()
      }
      settle()
    }

    return {
      durationMs: entry.durationMs,
      fallback: entry.fallback,
      play,
      stop,
      finished,
    }
  }

  async function synthesize(
    spoken: string,
    locale: string,
    signal?: AbortSignal,
  ): Promise<SynthesizedEntry | null> {
    if (signal?.aborted || disposed) return null

    const fallbackDuration = estimateSpeechMs(spoken, fallbackMsPerChar, minFallbackMs)

    if (options.ttsProvider) {
      try {
        const payload = await options.ttsProvider(spoken, signal)
        if (signal?.aborted || disposed) return null

        const rawBuffer =
          payload instanceof ArrayBuffer
            ? payload
            : typeof (payload as Blob).arrayBuffer === 'function'
              ? await (payload as Blob).arrayBuffer()
              : (() => {
                  throw new TypeError('ttsProvider must resolve to a Blob or ArrayBuffer.')
                })()
        if (signal?.aborted || disposed) return null

        const ctx = player.init()
        const decoded = await ctx.decodeAudioData(rawBuffer.slice(0))
        if (signal?.aborted || disposed) return null

        const durationMs =
          Number.isFinite(decoded.duration) && decoded.duration > 0
            ? Math.round(decoded.duration * 1000)
            : fallbackDuration

        return {
          buffer: decoded,
          durationMs,
          fallback: false,
          spoken,
          locale,
        }
      } catch (error) {
        if (signal?.aborted || isAbortError(error) || disposed) {
          return null
        }
        if (!allowFallback) {
          return {
            buffer: null,
            durationMs: fallbackDuration,
            fallback: true,
            spoken,
            locale,
          }
        }
      }
    }

    return {
      buffer: null,
      durationMs: fallbackDuration,
      fallback: true,
      spoken,
      locale,
    }
  }

  async function warmEntry(
    spoken: string,
    locale: string,
    signal?: AbortSignal,
  ): Promise<SynthesizedEntry | null> {
    if (!spoken || disposed || signal?.aborted) return null
    const key = keyOf(spoken, locale)
    const cached = cache.get(key)
    if (cached) return cached

    const inFlight = waiting.get(key)
    if (inFlight) return inFlight

    const job = warmChain.then(async () => {
      if (signal?.aborted || disposed) return null
      const entry = await synthesize(spoken, locale, signal)
      if (entry && !disposed) {
        cache.set(key, entry)
      }
      return entry
    })

    warmChain = job.then(
      () => undefined,
      () => undefined,
    )
    waiting.set(key, job)

    try {
      return await job
    } finally {
      waiting.delete(key)
    }
  }

  async function warm(
    text: string,
    speakOptions: SpeakOptions = {},
  ): Promise<SpeechBeat | null> {
    const spoken = text.trim()
    if (!spoken || disposed) return null
    const locale = normalizeLocale(speakOptions.locale ?? defaultLocale)
    const entry = await warmEntry(spoken, locale)
    return entry ? createBeat(entry) : null
  }

  function clearQueue(): void {
    while (queue.length > 0) {
      const item = queue.shift()!
      item.cancelled = true
      item.controller.abort()
      item.resolve(null)
    }
  }

  function stop(): void {
    generation += 1
    clearQueue()
    activeSynthesisController?.abort()
    activeSynthesisController = null
    activeBeat?.stop()
    activeBeat = null
  }

  async function speak(
    text: string,
    speakOptions: SpeakOptions = {},
  ): Promise<SpeechBeat | null> {
    if (disposed) return null
    stop()
    const mine = generation
    const spoken = text.trim()
    if (!spoken) return null

    const locale = normalizeLocale(speakOptions.locale ?? defaultLocale)
    const controller = new AbortController()
    activeSynthesisController = controller

    const key = keyOf(spoken, locale)
    const entry =
      cache.get(key) ??
      (await (waiting.get(key) ?? synthesize(spoken, locale, controller.signal)))

    if (activeSynthesisController === controller) {
      activeSynthesisController = null
    }
    if (!entry || mine !== generation || controller.signal.aborted || disposed) {
      return null
    }

    cache.set(key, entry)
    const beat = createBeat(entry)
    activeBeat = beat
    beat.play()
    void beat.finished.then(() => {
      if (activeBeat === beat) {
        activeBeat = null
      }
    })
    return beat
  }

  async function drainQueue(): Promise<void> {
    if (draining) return
    draining = true
    try {
      while (queue.length > 0 && !disposed) {
        const item = queue.shift()!
        if (item.cancelled || item.controller.signal.aborted) {
          item.resolve(null)
          continue
        }

        const mine = generation
        activeSynthesisController = item.controller
        const key = keyOf(item.text, item.locale)
        const entry =
          cache.get(key) ??
          (await (waiting.get(key) ??
            synthesize(item.text, item.locale, item.controller.signal)))

        if (activeSynthesisController === item.controller) {
          activeSynthesisController = null
        }

        if (
          !entry ||
          item.cancelled ||
          item.controller.signal.aborted ||
          mine !== generation ||
          disposed
        ) {
          item.resolve(null)
          continue
        }

        cache.set(key, entry)
        const beat = createBeat(entry)
        activeBeat = beat
        beat.play()
        item.resolve(beat)

        await beat.finished
        if (activeBeat === beat) {
          activeBeat = null
        }
      }
    } finally {
      draining = false
    }
  }

  function enqueue(
    text: string,
    speakOptions: SpeakOptions = {},
  ): Promise<SpeechBeat | null> {
    const spoken = text.trim()
    if (!spoken || disposed) {
      return Promise.resolve(null)
    }
    const locale = normalizeLocale(speakOptions.locale ?? defaultLocale)
    const controller = new AbortController()

    return new Promise<SpeechBeat | null>((resolve) => {
      queue.push({
        text: spoken,
        locale,
        controller,
        cancelled: false,
        resolve,
      })
      void drainQueue()
    })
  }

  async function dispose(): Promise<void> {
    if (disposed) return
    disposed = true
    stop()
    const pending = [...waiting.values()]
    waiting.clear()
    cache.clear()
    warmChain = Promise.resolve()
    await Promise.allSettled(pending)
    if (ownsPlayer) {
      await player.dispose()
    }
  }

  return {
    player,
    get queueLength() {
      return queue.length
    },
    get isSpeaking() {
      return activeBeat !== null
    },
    estimateDurationMs: (text) =>
      estimateSpeechMs(text, fallbackMsPerChar, minFallbackMs),
    warm,
    speak,
    enqueue,
    clearQueue,
    stop,
    dispose,
  }
}
