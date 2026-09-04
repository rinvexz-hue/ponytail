import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import type { AgentId, AgentState } from '../types'
import { AGENT_DESCRIPTIONS, AGENT_META } from '../lib/agents'
import { AGENT_ICONS } from '../lib/agentIcons'
import { Sparkline } from './Sparkline'
import { formatPct } from '../lib/format'
import { statusColor } from './AgentTile'

interface AgentNodeProps {
  agentId: AgentId
  agent: AgentState
  x: number
  y: number
  selected: boolean
  onSelect: (id: AgentId) => void
}

export function AgentNode({ agentId, agent, x, y, selected, onSelect }: AgentNodeProps) {
  const meta = AGENT_META[agentId]
  const Icon = AGENT_ICONS[agentId]
  const dotColor = statusColor(agent.status)
  const [hovered, setHovered] = useState(false)
  // Nodes near the top of the ring would push their tooltip off-screen if it
  // always opened upward, so flip it below the node up there instead.
  const openBelow = y < 35
  // Same idea horizontally: a tooltip centered on a node near the left/right
  // edge of the ring runs past the container (or under a neighboring node)
  // on narrow mobile widths, so anchor it to whichever side has room instead
  // of always centering.
  const anchorLeft = x < 35
  const anchorRight = x > 65
  const horizontalPositionClass = anchorLeft ? 'left-0' : anchorRight ? 'right-0' : 'left-1/2'

  return (
    <motion.button
      onClick={() => onSelect(agentId)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setHovered(true)}
      onBlur={() => setHovered(false)}
      className="absolute z-10 flex h-11 w-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border bg-void-panel/95 shadow-panel backdrop-blur-sm sm:h-auto sm:w-[124px] sm:flex-col sm:items-stretch sm:justify-start sm:gap-1 sm:rounded-lg sm:px-2.5 sm:py-2 sm:text-left"
      style={{
        left: `${x}%`,
        top: `${y}%`,
        borderColor: selected ? meta.color : 'rgba(255,255,255,0.08)',
        boxShadow: selected ? `0 0 16px -2px ${meta.glow}` : undefined,
      }}
      animate={agent.status === 'EXECUTING' ? { scale: [1, 1.04, 1] } : { scale: 1 }}
      transition={{ duration: 1.1, repeat: agent.status === 'EXECUTING' ? Infinity : 0, ease: 'easeInOut' }}
    >
      <AnimatePresence>
        {hovered && (
          // AnimatePresence needs its direct child to be the motion
          // component to animate the exit, so the centering transform can't
          // live on a separate wrapper — instead it's passed as a static `x`
          // in `style`, which framer-motion combines with the animated `y`
          // into one transform. (A Tailwind `-translate-x-1/2` class here
          // would silently lose to framer-motion's own transform instead.)
          <motion.div
            initial={{ opacity: 0, y: openBelow ? -4 : 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className={
              'pointer-events-none absolute z-30 w-44 rounded-lg border bg-void-panel px-3 py-2 text-left shadow-panel ' +
              horizontalPositionClass +
              ' ' +
              (openBelow ? 'top-full mt-2' : 'bottom-full mb-2')
            }
            style={{ borderColor: meta.color, x: anchorLeft || anchorRight ? 0 : '-50%' }}
          >
            <div className="mb-1 flex items-center gap-1.5">
              <Icon size={11} color={meta.color} />
              <span className="font-mono text-[10px] font-bold tracking-wide" style={{ color: meta.color }}>
                {meta.name}
              </span>
            </div>
            <p className="font-mono text-[10px] leading-snug text-slate-300">{AGENT_DESCRIPTIONS[agentId]}</p>
          </motion.div>
        )}
      </AnimatePresence>

      {/* compact mobile badge */}
      <span className="relative flex items-center justify-center sm:hidden">
        <Icon size={16} color={meta.color} />
        <span
          className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full"
          style={{ backgroundColor: dotColor, boxShadow: `0 0 5px 1px ${dotColor}` }}
        />
      </span>

      {/* full card, sm and up */}
      <div className="hidden sm:flex sm:flex-col sm:gap-1">
        <div className="flex items-center gap-1.5">
          <Icon size={12} color={meta.color} />
          <span className="truncate font-mono text-[10px] font-bold tracking-wide text-slate-200">{meta.name}</span>
        </div>
        <span className="font-mono text-[9px] text-slate-500">{meta.role}</span>
        <Sparkline data={agent.sparkline} color={meta.color} height={20} />
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-1 font-mono text-[9px] font-semibold text-slate-400">
            <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: dotColor, boxShadow: `0 0 5px 1px ${dotColor}` }} />
            {agent.status}
          </span>
          <span className={'font-mono text-[10px] font-bold ' + (agent.value >= 0 ? 'text-profit' : 'text-loss')}>
            {formatPct(agent.value, 1)}
          </span>
        </div>
      </div>
    </motion.button>
  )
}
