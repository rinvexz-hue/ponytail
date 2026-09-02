import type { LogEntry, TickerState } from '../types'

// Bridges the AlphaRadar Fase-1 pipeline (see the `alpharadar` repo,
// `feed/app.py`) into this dashboard. AlphaRadar has no executor and no
// positions yet, so this feed is intentionally QUOTE-only: every LogEntry
// it produces has action="QUOTE" and pnl=null — it never claims a
// BUY/SELL/FILL/HEDGE happened, because none did. Treat it as a real
// activity log + ticker tape layered on top of the swarm simulation, not
// as a replacement for it — kpis/agents/candles/meters stay simulated
// until AlphaRadar has real positions to report (Fase 3/4).
//
// Connects via Server-Sent Events (`GET {baseUrl}/stream`), which replays
// recent history (oldest-first) before switching to live push, so a single
// EventSource is enough — no separate REST backfill needed. Reconnects
// with a fixed backoff on error/drop.

export interface AlphaRadarFeedHandlers {
  onLogEntry: (entry: LogEntry) => void
  onTicker: (ticker: TickerState) => void
  onConnectionChange?: (connected: boolean) => void
}

const RECONNECT_DELAY_MS = 3000

export function startAlphaRadarFeed(baseUrl: string, handlers: AlphaRadarFeedHandlers): () => void {
  let stopped = false
  let es: EventSource | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null

  function connect() {
    if (stopped) return
    es = new EventSource(`${baseUrl}/stream`)

    es.addEventListener('log_entry', (e) => {
      try {
        handlers.onLogEntry(JSON.parse((e as MessageEvent).data))
      } catch (err) {
        console.warn('[alpharadar-feed] malformed log_entry', err)
      }
    })

    es.addEventListener('ticker', (e) => {
      try {
        handlers.onTicker(JSON.parse((e as MessageEvent).data))
      } catch (err) {
        console.warn('[alpharadar-feed] malformed ticker', err)
      }
    })

    es.onopen = () => handlers.onConnectionChange?.(true)

    es.onerror = () => {
      handlers.onConnectionChange?.(false)
      es?.close()
      es = null
      if (!stopped) reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS)
    }
  }

  connect()

  return () => {
    stopped = true
    if (reconnectTimer) clearTimeout(reconnectTimer)
    es?.close()
  }
}
