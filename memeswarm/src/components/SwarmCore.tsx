import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useSwarmStore } from '../store'
import { AGENT_IDS, AGENT_META } from '../lib/agents'
import { AgentNode } from './AgentNode'
import { AgentTile } from './AgentTile'
import { MeterBar } from './MeterBar'
import type { AgentId } from '../types'

function nodePosition(index: number, total: number, rx: number, ry: number) {
  const angle = (index / total) * Math.PI * 2 - Math.PI / 2
  return {
    x: 50 + rx * Math.cos(angle),
    y: 50 + ry * Math.sin(angle),
  }
}

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia('(max-width: 639px)').matches : false,
  )
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 639px)')
    const onChange = () => setIsMobile(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return isMobile
}

export function SwarmCore() {
  const agents = useSwarmStore((s) => s.agents)
  const armLoad = useSwarmStore((s) => s.armLoad)
  const gripTorque = useSwarmStore((s) => s.gripTorque)
  const selectedAgentId = useSwarmStore((s) => s.selectedAgentId) as AgentId | null
  const selectAgent = useSwarmStore((s) => s.selectAgent)
  const isMobile = useIsMobile()
  const rx = isMobile ? 34 : 40
  const ry = isMobile ? 40 : 36

  const [pulsing, setPulsing] = useState<Partial<Record<AgentId, boolean>>>({})
  const timers = useRef<Partial<Record<AgentId, ReturnType<typeof setTimeout>>>>({})

  useEffect(() => {
    for (const id of AGENT_IDS) {
      if (agents[id]?.justExecuted) {
        setPulsing((prev) => ({ ...prev, [id]: true }))
        clearTimeout(timers.current[id])
        timers.current[id] = setTimeout(() => {
          setPulsing((prev) => ({ ...prev, [id]: false }))
        }, 900)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents])

  const positions = useMemo(
    () =>
      Object.fromEntries(AGENT_IDS.map((id, i) => [id, nodePosition(i, AGENT_IDS.length, rx, ry)])) as Record<
        AgentId,
        { x: number; y: number }
      >,
    [rx, ry],
  )

  if (!agents.scout) return null

  return (
    <section className="px-4 pb-4 sm:px-6">
      <div className="rounded-lg border border-void-border bg-void-panel p-4 shadow-panel shadow-inner-glow sm:p-6">
        <h2 className="mb-3 font-mono text-xs font-semibold tracking-widest text-slate-400">SWARM CORE</h2>

        <div className="relative h-[340px] w-full sm:h-[460px]">
          <svg className="absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none">
            {AGENT_IDS.map((id) => {
              const pos = positions[id]
              const meta = AGENT_META[id]
              const agent = agents[id]
              const isExecuting = agent.status === 'EXECUTING'
              const isSelected = selectedAgentId === id
              const pathD = `M50 50 L${pos.x} ${pos.y}`
              return (
                <g key={id}>
                  <path
                    d={pathD}
                    stroke={isExecuting || isSelected ? meta.color : '#2a2a38'}
                    strokeWidth={isExecuting || isSelected ? 0.5 : 0.3}
                    strokeOpacity={isExecuting || isSelected ? 0.85 : 0.6}
                    fill="none"
                  />
                  {isExecuting && (
                    <motion.path
                      d={pathD}
                      stroke={meta.color}
                      strokeWidth={0.6}
                      strokeDasharray="2 3"
                      fill="none"
                      animate={{ strokeDashoffset: [0, -10] }}
                      transition={{ duration: 0.7, repeat: Infinity, ease: 'linear' }}
                    />
                  )}
                  <AnimatePresence>
                    {pulsing[id] && (
                      <motion.circle
                        key={`pulse-${id}`}
                        r={1.6}
                        fill={meta.color}
                        initial={{ offsetDistance: '0%', opacity: 1 }}
                        animate={{ offsetDistance: '100%', opacity: 0 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.85, ease: 'easeOut' }}
                        style={{ offsetPath: `path('${pathD}')` }}
                      />
                    )}
                  </AnimatePresence>
                </g>
              )
            })}
          </svg>

          <Mascot />

          {AGENT_IDS.map((id) => (
            <AgentNode
              key={id}
              agentId={id}
              agent={agents[id]}
              x={positions[id].x}
              y={positions[id].y}
              selected={selectedAgentId === id}
              onSelect={(clicked) => selectAgent(selectedAgentId === clicked ? null : clicked)}
            />
          ))}
        </div>

        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:gap-6">
          <MeterBar label="ARM LOAD" value={armLoad} color="#38bdf8" />
          <MeterBar label="GRIP TORQUE" value={gripTorque} color="#f59e0b" align="right" />
        </div>

        <div className="mt-4 flex gap-2 overflow-x-auto pb-1">
          {AGENT_IDS.map((id) => (
            <AgentTile
              key={id}
              agentId={id}
              agent={agents[id]}
              selected={selectedAgentId === id}
              onSelect={(clicked) => selectAgent(selectedAgentId === clicked ? null : clicked)}
            />
          ))}
        </div>
      </div>
    </section>
  )
}

function Mascot() {
  return (
    <div className="absolute left-1/2 top-1/2 z-[5] -translate-x-1/2 -translate-y-1/2">
      <motion.div
        className="relative flex h-20 w-20 items-center justify-center rounded-full border border-amber/40 bg-void-raised sm:h-24 sm:w-24"
        animate={{
          boxShadow: [
            '0 0 24px -6px rgba(245,158,11,0.5)',
            '0 0 40px -4px rgba(245,158,11,0.8)',
            '0 0 24px -6px rgba(245,158,11,0.5)',
          ],
        }}
        transition={{ duration: 2.4, repeat: Infinity, ease: 'easeInOut' }}
      >
        <svg viewBox="0 0 100 100" width="58" height="58" fill="none">
          <circle cx="50" cy="42" r="26" fill="#f59e0b" fillOpacity={0.92} />
          <circle cx="41" cy="38" r="4" fill="#0a0a0f" />
          <circle cx="59" cy="38" r="4" fill="#0a0a0f" />
          <circle cx="41" cy="38" r="1.4" fill="#fff" />
          <circle cx="59" cy="38" r="1.4" fill="#fff" />
          <path d="M40 50 Q50 56 60 50" stroke="#0a0a0f" strokeWidth="2.5" strokeLinecap="round" fill="none" />
          {[0, 1, 2, 3, 4, 5].map((i) => {
            const angle = (i / 6) * Math.PI + Math.PI * 0.08
            const x1 = 50 + Math.cos(angle) * 22
            const y1 = 62 + Math.sin(angle) * 6
            const x2 = 50 + Math.cos(angle) * 38
            const y2 = 90 + Math.sin(angle) * 4
            return (
              <motion.path
                key={i}
                d={`M${x1} ${y1} Q${(x1 + x2) / 2 + 6} ${(y1 + y2) / 2} ${x2} ${y2}`}
                stroke="#f59e0b"
                strokeWidth="3.5"
                strokeLinecap="round"
                fill="none"
                animate={{ d: [
                  `M${x1} ${y1} Q${(x1 + x2) / 2 + 6} ${(y1 + y2) / 2} ${x2} ${y2}`,
                  `M${x1} ${y1} Q${(x1 + x2) / 2 - 6} ${(y1 + y2) / 2} ${x2} ${y2}`,
                  `M${x1} ${y1} Q${(x1 + x2) / 2 + 6} ${(y1 + y2) / 2} ${x2} ${y2}`,
                ] }}
                transition={{ duration: 3 + i * 0.2, repeat: Infinity, ease: 'easeInOut' }}
              />
            )
          })}
        </svg>
      </motion.div>
    </div>
  )
}
