import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { Volume2, VolumeX } from 'lucide-react'
import { useSwarmStore } from '../store'
import { useSoundStore } from '../sounds'
import { formatUptime } from '../lib/format'
import { AGENT_IDS } from '../lib/agents'
import type { MarketStatus, RiskSessionState } from '../types'

export function Header() {
  const cycle = useSwarmStore((s) => s.cycle)
  const sessionStart = useSwarmStore((s) => s.sessionStart)
  const marketStatus = useSwarmStore((s) => s.marketStatus)
  const marketStatusDetail = useSwarmStore((s) => s.marketStatusDetail)
  const riskSession = useSwarmStore((s) => s.riskSession)
  const soundEnabled = useSoundStore((s) => s.enabled)
  const toggleSound = useSoundStore((s) => s.toggle)

  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  return (
    <header className="flex flex-col gap-4 border-b border-void-border px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
      <div className="flex items-center gap-3">
        <MascotMark />
        <div>
          <div className="flex items-center gap-2">
            <h1 className="font-mono text-lg font-extrabold tracking-widest text-slate-100 sm:text-xl">
              MEMESWARM
            </h1>
            <span className="rounded border border-amber/40 bg-amber/10 px-1.5 py-0.5 font-mono text-[10px] font-bold tracking-wider text-amber-soft">
              SWARM
            </span>
          </div>
          <p className="font-mono text-[11px] tracking-wide text-slate-500">
            AUTONOMOUS TRADING FLOOR · {AGENT_IDS.length} ARMS / {AGENT_IDS.length} AGENTS
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 font-mono text-xs">
        <Stat label="CYCLE" value={cycle.toLocaleString()} />
        <Stat label="UPTIME" value={formatUptime(now - sessionStart)} />
        <MarketStatusPill status={marketStatus} detail={marketStatusDetail} />
        <RiskSessionPill riskSession={riskSession} />
        <div className="flex items-center gap-1.5 rounded-full border border-profit/30 bg-profit/10 px-2.5 py-1">
          <span className="h-1.5 w-1.5 animate-pulseDot rounded-full bg-profit shadow-[0_0_8px_2px_rgba(34,197,94,0.6)]" />
          <span className="font-semibold text-profit">LIVE</span>
        </div>
        <button
          onClick={toggleSound}
          aria-label={soundEnabled ? 'Mute sound' : 'Enable sound'}
          className="flex h-7 w-7 items-center justify-center rounded-md border border-void-border bg-void-raised text-slate-400 transition hover:border-amber/40 hover:text-amber-soft"
        >
          {soundEnabled ? <Volume2 size={14} /> : <VolumeX size={14} />}
        </button>
      </div>
    </header>
  )
}

const MARKET_STATUS_META: Record<MarketStatus, { label: string; color: string; bg: string; border: string }> = {
  live: { label: 'MARKET: LIVE', color: 'text-profit', bg: 'bg-profit/10', border: 'border-profit/30' },
  connecting: { label: 'MARKET: CONNECTING', color: 'text-amber-soft', bg: 'bg-amber/10', border: 'border-amber/30' },
  degraded: { label: 'MARKET: DEGRADED', color: 'text-amber-soft', bg: 'bg-amber/10', border: 'border-amber/30' },
  error: { label: 'MARKET: OFFLINE', color: 'text-loss', bg: 'bg-loss/10', border: 'border-loss/30' },
}

function MarketStatusPill({ status, detail }: { status: MarketStatus; detail?: string }) {
  const meta = MARKET_STATUS_META[status]
  return (
    <div
      className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 ${meta.bg} ${meta.border}`}
      title={detail ?? 'Real, read-only prices from Dexscreener — no wallet, no execution.'}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${meta.color} ${status === 'live' ? 'animate-pulseDot' : ''}`}
        style={{ backgroundColor: 'currentColor' }}
      />
      <span className={`font-semibold ${meta.color}`}>{meta.label}</span>
    </div>
  )
}

function RiskSessionPill({ riskSession }: { riskSession: RiskSessionState }) {
  const tripped = riskSession.killSwitchActive
  const atCeiling = riskSession.entriesUsed >= riskSession.entryLimit
  const blocked = tripped || atCeiling
  return (
    <div
      className={
        'flex items-center gap-1.5 rounded-full border px-2.5 py-1 ' +
        (blocked ? 'border-loss/30 bg-loss/10' : 'border-void-border bg-void-raised')
      }
      title={
        tripped
          ? 'Kill-switch tripped — session drawdown limit hit, new entries paused until the session resets.'
          : 'New entries this session vs. the hard per-session ceiling — caps how much a hot streak can over-concentrate.'
      }
    >
      <span className={'font-semibold ' + (blocked ? 'text-loss' : 'text-slate-400')}>
        {tripped ? 'KILL-SWITCH' : `TICKETS ${riskSession.entriesUsed}/${riskSession.entryLimit}`}
      </span>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col leading-tight">
      <span className="text-[10px] tracking-wider text-slate-600">{label}</span>
      <span className="font-semibold text-slate-200" style={{ fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </span>
    </div>
  )
}

function MascotMark() {
  return (
    <motion.div
      className="relative flex h-10 w-10 items-center justify-center rounded-lg border border-amber/30 bg-void-raised shadow-[0_0_20px_-4px_rgba(245,158,11,0.5)]"
      animate={{ boxShadow: ['0 0 14px -4px rgba(245,158,11,0.4)', '0 0 22px -2px rgba(245,158,11,0.7)', '0 0 14px -4px rgba(245,158,11,0.4)'] }}
      transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}
    >
      <svg viewBox="0 0 32 32" width="22" height="22" fill="none">
        <circle cx="16" cy="14" r="8" fill="#f59e0b" fillOpacity={0.9} />
        <circle cx="13" cy="12" r="1.4" fill="#0a0a0f" />
        <circle cx="19" cy="12" r="1.4" fill="#0a0a0f" />
        {[0, 1, 2, 3].map((i) => (
          <path
            key={i}
            d={`M ${9 + i * 5} 20 Q ${8 + i * 5} 26 ${10 + i * 5} 30`}
            stroke="#f59e0b"
            strokeWidth="2"
            strokeLinecap="round"
            fill="none"
          />
        ))}
      </svg>
    </motion.div>
  )
}
