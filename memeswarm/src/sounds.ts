// Self-contained sound design for MEMESWARM — every tone is synthesized to a
// short WAV data URI at module load, so there are no external audio assets
// to fetch. Howler.js handles playback, throttling keeps rapid ticks from
// spamming audio, and everything stays muted until the user "arms" it with
// one click (autoplay-policy friendly).

import { Howl } from 'howler'
import { create } from 'zustand'
import type { SimEvent } from './types'

const SAMPLE_RATE = 44100

function synthesize(durationSec: number, fn: (t: number) => number): string {
  const frameCount = Math.floor(SAMPLE_RATE * durationSec)
  const buffer = new ArrayBuffer(44 + frameCount * 2)
  const view = new DataView(buffer)

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i))
  }

  writeString(0, 'RIFF')
  view.setUint32(4, 36 + frameCount * 2, true)
  writeString(8, 'WAVE')
  writeString(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, SAMPLE_RATE, true)
  view.setUint32(28, SAMPLE_RATE * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeString(36, 'data')
  view.setUint32(40, frameCount * 2, true)

  for (let i = 0; i < frameCount; i++) {
    const t = i / SAMPLE_RATE
    const sample = clamp(fn(t), -1, 1)
    view.setInt16(44 + i * 2, sample * 0x7fff, true)
  }

  let binary = ''
  const bytes = new Uint8Array(buffer)
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return `data:audio/wav;base64,${btoa(binary)}`
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v))
}

function envelope(t: number, duration: number, attack = 0.01, release = 0.12) {
  if (t < attack) return t / attack
  const remaining = duration - t
  if (remaining < release) return Math.max(0, remaining / release)
  return 1
}

function tone(freq: number, duration: number, wave: (phase: number) => number = Math.sin) {
  return synthesize(duration, (t) => wave(2 * Math.PI * freq * t) * envelope(t, duration))
}

function chord(freqs: number[], duration: number, stagger = 0) {
  return synthesize(duration, (t) => {
    let sum = 0
    freqs.forEach((f, i) => {
      const start = i * stagger
      if (t < start) return
      const local = t - start
      const localDur = duration - start
      sum += Math.sin(2 * Math.PI * f * local) * envelope(local, localDur, 0.005, 0.1)
    })
    return sum / Math.sqrt(freqs.length)
  })
}

// --- synthesized assets ---
const PROFIT_URI = chord([660, 880], 0.28, 0.07)
const ATH_URI = chord([523, 659, 784, 1046], 0.4, 0.06)
const LOSS_URI = tone(140, 0.22, (p) => Math.sin(p) * 0.6 + Math.sin(p * 0.5) * 0.4)
const RISK_URI = chord([220, 196], 0.24, 0.09)

const profitHowl = new Howl({ src: [PROFIT_URI], format: ['wav'], preload: true, volume: 0.5 })
const athHowl = new Howl({ src: [ATH_URI], format: ['wav'], preload: true, volume: 0.6 })
const lossHowl = new Howl({ src: [LOSS_URI], format: ['wav'], preload: true, volume: 0.35 })
const riskHowl = new Howl({ src: [RISK_URI], format: ['wav'], preload: true, volume: 0.3 })

const THROTTLE_MS = 400
let lastPlayedAt = 0

interface SoundStore {
  enabled: boolean
  toggle: () => void
}

export const useSoundStore = create<SoundStore>((set, get) => ({
  enabled: false,
  toggle: () => set({ enabled: !get().enabled }),
}))

function throttledPlay(howl: Howl, rate = 1) {
  const now = performance.now()
  if (now - lastPlayedAt < THROTTLE_MS) return
  lastPlayedAt = now
  howl.rate(clamp(rate, 0.75, 1.5))
  howl.play()
}

export function playSoundForEvent(event: SimEvent) {
  if (!useSoundStore.getState().enabled) return

  switch (event.type) {
    case 'profit': {
      const rate = 1 + clamp(event.pnl / 4000, 0, 0.35)
      throttledPlay(profitHowl, rate)
      break
    }
    case 'ath':
      throttledPlay(athHowl, 1)
      break
    case 'loss':
      throttledPlay(lossHowl, 1)
      break
    case 'riskFlag':
      throttledPlay(riskHowl, 1)
      break
    default:
      break
  }
}
