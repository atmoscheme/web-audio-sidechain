export class MockAudioParam {
  value: number
  scheduled: Array<
    | { type: 'cancel'; time: number }
    | { type: 'set'; value: number; time: number }
    | { type: 'linearRamp'; value: number; endTime: number }
    | { type: 'expRamp'; value: number; endTime: number }
  > = []

  constructor(initialValue = 1) {
    this.value = initialValue
  }

  cancelScheduledValues(time: number): this {
    this.scheduled.push({ type: 'cancel', time })
    return this
  }

  setValueAtTime(value: number, time: number): this {
    this.value = value
    this.scheduled.push({ type: 'set', value, time })
    return this
  }

  linearRampToValueAtTime(value: number, endTime: number): this {
    this.value = value
    this.scheduled.push({ type: 'linearRamp', value, endTime })
    return this
  }

  exponentialRampToValueAtTime(value: number, endTime: number): this {
    this.value = value
    this.scheduled.push({ type: 'expRamp', value, endTime })
    return this
  }
}

export class MockAudioNode {
  connections: AudioNode[] = []
  disconnected = false

  connect(destination: AudioNode): AudioNode {
    this.connections.push(destination)
    return destination
  }

  disconnect(): void {
    this.disconnected = true
    this.connections.length = 0
  }
}

export class MockGainNode extends MockAudioNode {
  gain = new MockAudioParam(1)
}

export class MockAnalyserNode extends MockAudioNode {
  fftSize = 256
  smoothingTimeConstant = 0.8
  nextTimeDomainSamples: Uint8Array | null = null
  nextFrequencyBins: Uint8Array | null = null

  get frequencyBinCount(): number {
    return this.fftSize / 2
  }

  getByteTimeDomainData(array: Uint8Array): void {
    if (this.nextTimeDomainSamples) {
      for (let i = 0; i < array.length; i++) {
        array[i] = this.nextTimeDomainSamples[i] ?? 128
      }
      return
    }
    array.fill(128)
  }

  getByteFrequencyData(array: Uint8Array): void {
    if (this.nextFrequencyBins) {
      for (let i = 0; i < array.length; i++) {
        array[i] = this.nextFrequencyBins[i] ?? 0
      }
      return
    }
    array.fill(0)
  }
}

export class MockAudioBufferSourceNode extends MockAudioNode {
  buffer: AudioBuffer | null = null
  onended: (() => void) | null = null
  startedAt: number | null = null
  stoppedAt: number | null = null

  start(when = 0): void {
    this.startedAt = when
  }

  stop(when = 0): void {
    this.stoppedAt = when
  }

  triggerEnded(): void {
    this.onended?.()
  }
}

export class MockOscillatorNode extends MockAudioNode {
  type: OscillatorType = 'sine'
  frequency = new MockAudioParam(440)
  startedAt: number | null = null
  stoppedAt: number | null = null

  start(when = 0): void {
    this.startedAt = when
  }

  stop(when = 0): void {
    this.stoppedAt = when
  }
}

export class MockMediaElementAudioSourceNode extends MockAudioNode {
  constructor(public readonly mediaElement: HTMLAudioElement) {
    super()
  }
}

export class MockAudioContext {
  state: AudioContextState = 'suspended'
  currentTime = 0
  destination = new MockAudioNode() as unknown as AudioDestinationNode

  gainNodes: MockGainNode[] = []
  analyserNodes: MockAnalyserNode[] = []
  bufferSources: MockAudioBufferSourceNode[] = []
  oscillators: MockOscillatorNode[] = []
  mediaSources: MockMediaElementAudioSourceNode[] = []

  resumeCalls = 0
  closeCalls = 0
  decodeResultDuration = 1.5
  decodeShouldFail = false

  async resume(): Promise<void> {
    this.resumeCalls += 1
    this.state = 'running'
  }

  async close(): Promise<void> {
    this.closeCalls += 1
    this.state = 'closed'
  }

  createGain(): GainNode {
    const node = new MockGainNode()
    this.gainNodes.push(node)
    return node as unknown as GainNode
  }

  createAnalyser(): AnalyserNode {
    const node = new MockAnalyserNode()
    this.analyserNodes.push(node)
    return node as unknown as AnalyserNode
  }

  createBufferSource(): AudioBufferSourceNode {
    const node = new MockAudioBufferSourceNode()
    this.bufferSources.push(node)
    return node as unknown as AudioBufferSourceNode
  }

  createOscillator(): OscillatorNode {
    const node = new MockOscillatorNode()
    this.oscillators.push(node)
    return node as unknown as OscillatorNode
  }

  createMediaElementSource(element: HTMLAudioElement): MediaElementAudioSourceNode {
    const node = new MockMediaElementAudioSourceNode(element)
    this.mediaSources.push(node)
    return node as unknown as MediaElementAudioSourceNode
  }

  async decodeAudioData(_audioData: ArrayBuffer): Promise<AudioBuffer> {
    if (this.decodeShouldFail) {
      throw new Error('Decoding failed')
    }
    return {
      duration: this.decodeResultDuration,
      length: Math.round(44100 * this.decodeResultDuration),
      numberOfChannels: 1,
      sampleRate: 44100,
    } as AudioBuffer
  }
}

export class MockAudioElement {
  src = ''
  loop = false
  preload = 'auto'
  volume = 1
  muted = false
  currentTime = 0
  duration = 120
  ended = false
  paused = true
  playCalls = 0
  loadCalls = 0
  private listeners = new Map<string, Set<() => void>>()

  getAttribute(name: string): string | null {
    return name === 'src' ? this.src : null
  }

  load(): void {
    this.loadCalls += 1
  }

  async play(): Promise<void> {
    this.playCalls += 1
    this.paused = false
  }

  pause(): void {
    this.paused = true
  }

  addEventListener(event: string, cb: () => void): void {
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(cb)
  }

  removeEventListener(event: string, cb: () => void): void {
    this.listeners.get(event)?.delete(cb)
  }

  emit(event: string): void {
    for (const cb of this.listeners.get(event) ?? []) {
      cb()
    }
  }
}

export class MockUtterance {
  lang = ''
  onend: (() => void) | null = null
  onerror: (() => void) | null = null

  constructor(public readonly text: string) {}
}

export class MockSpeechSynthesis {
  spoken: MockUtterance[] = []
  cancelCalls = 0

  speak(utterance: SpeechSynthesisUtterance): void {
    this.spoken.push(utterance as unknown as MockUtterance)
  }

  cancel(): void {
    this.cancelCalls += 1
  }
}

export function createManualScheduler() {
  let nextId = 1
  const callbacks = new Map<number, () => void>()

  return {
    scheduler: {
      requestFrame: (cb: () => void) => {
        const id = nextId++
        callbacks.set(id, cb)
        return id
      },
      cancelFrame: (id: number) => {
        callbacks.delete(id)
      },
    },
    flushFrame() {
      const entries = [...callbacks.entries()]
      callbacks.clear()
      for (const [, cb] of entries) {
        cb()
      }
    },
    get pendingCount() {
      return callbacks.size
    },
  }
}
