import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion, useAnimationFrame, useMotionValue, useTransform } from 'framer-motion'
import type { MotionValue } from 'framer-motion'
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

  // Shared clock driving every tentacle's wiggle — one rAF loop feeds all of
  // them via motion values, so the wiggle never touches React's render cycle.
  const time = useMotionValue(0)
  useAnimationFrame((t) => time.set(t / 1000))

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
            {AGENT_IDS.map((id, index) => {
              const pos = positions[id]
              const meta = AGENT_META[id]
              const agent = agents[id]
              const isExecuting = agent.status === 'EXECUTING'
              const isSelected = selectedAgentId === id
              return (
                <g key={id}>
                  <Tentacle
                    time={time}
                    x={pos.x}
                    y={pos.y}
                    index={index}
                    color={meta.color}
                    active={isExecuting || isSelected}
                  />
                  <AnimatePresence>
                    {pulsing[id] && (
                      <motion.circle
                        key={`pulse-${id}`}
                        r={1.6}
                        fill={meta.color}
                        initial={{ cx: 50, cy: 50, opacity: 1 }}
                        animate={{ cx: pos.x, cy: pos.y, opacity: 0 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.85, ease: 'easeOut' }}
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

// A tentacle is a cubic bezier from the mascot's center (50,50) out to its
// agent node, wobbling perpendicular to that line on a shared clock. It's
// idle and subtle at rest, and curls harder + faster while EXECUTING/
// selected — same color language as before, just alive instead of static.
interface TentacleProps {
  time: MotionValue<number>
  x: number
  y: number
  index: number
  color: string
  active: boolean
}

function buildTentaclePath(t: number, x: number, y: number, index: number, active: boolean) {
  const cx = 50
  const cy = 50
  const dx = x - cx
  const dy = y - cy
  const dist = Math.hypot(dx, dy) || 1
  const nx = -dy / dist
  const ny = dx / dist
  const freq = active ? 2.1 : 0.55
  const amp = active ? 4.2 : 1.4
  const phase = index * 1.7
  const wob1 = Math.sin(t * freq + phase) * amp
  const wob2 = Math.sin(t * freq + phase + Math.PI / 2) * amp * 0.7
  const c1x = cx + dx * 0.33 + nx * wob1
  const c1y = cy + dy * 0.33 + ny * wob1
  const c2x = cx + dx * 0.66 + nx * wob2
  const c2y = cy + dy * 0.66 + ny * wob2
  return `M ${cx} ${cy} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${x} ${y}`
}

function Tentacle({ time, x, y, index, color, active }: TentacleProps) {
  const d = useTransform(time, (t) => buildTentaclePath(t, x, y, index, active))
  return (
    <>
      <motion.path
        style={{ d }}
        stroke={active ? color : '#3a3a4a'}
        strokeWidth={active ? 1.8 : 0.9}
        strokeOpacity={active ? 0.9 : 0.55}
        strokeLinecap="round"
        fill="none"
      />
      {active && (
        <motion.path
          style={{ d }}
          stroke={color}
          strokeWidth={0.7}
          strokeDasharray="2 3"
          strokeOpacity={0.85}
          fill="none"
          animate={{ strokeDashoffset: [0, -10] }}
          transition={{ duration: 0.7, repeat: Infinity, ease: 'linear' }}
        />
      )}
    </>
  )
}

function Mascot() {
  return (
    <div className="absolute left-1/2 top-1/2 z-[5] -translate-x-1/2 -translate-y-1/2">
      <motion.div
        className="relative flex h-24 w-24 items-center justify-center rounded-full border border-amber/40 bg-void-raised sm:h-28 sm:w-28"
        animate={{
          boxShadow: [
            '0 0 28px -6px rgba(245,158,11,0.5)',
            '0 0 46px -4px rgba(245,158,11,0.85)',
            '0 0 28px -6px rgba(245,158,11,0.5)',
          ],
          scale: [1, 1.03, 1],
        }}
        transition={{ duration: 2.6, repeat: Infinity, ease: 'easeInOut' }}
      >
        <svg viewBox="0 0 100 100" width="76" height="76" fill="none">
          {/* rounded head, warm highlight for a bit of depth */}
          <ellipse cx="50" cy="47" rx="35" ry="31" fill="#f59e0b" fillOpacity={0.95} />
          <ellipse cx="38" cy="34" rx="13" ry="9" fill="#fde68a" fillOpacity={0.3} />
          {/* big friendly eyes */}
          <ellipse cx="35" cy="45" rx="12" ry="14" fill="#0a0a0f" />
          <ellipse cx="65" cy="45" rx="12" ry="14" fill="#0a0a0f" />
          <circle cx="38.5" cy="40" r="3.2" fill="#fff" />
          <circle cx="68.5" cy="40" r="3.2" fill="#fff" />
          {/* soft smile */}
          <path d="M39 64 Q50 71 61 64" stroke="#0a0a0f" strokeWidth="3" strokeLinecap="round" fill="none" />
          {/* short belly fringe — the long arms doing the real work are the tentacles */}
          {[0, 1, 2, 3].map((i) => (
            <path
              key={i}
              d={`M ${30 + i * 13} 76 Q ${28 + i * 13} 85 ${33 + i * 13} 91`}
              stroke="#f59e0b"
              strokeWidth="4.5"
              strokeLinecap="round"
              fill="none"
            />
          ))}
        </svg>
      </motion.div>
    </div>
  )
}
