import { motion } from 'framer-motion'
import type { AgentId, AgentState } from '../types'
import { AGENT_META } from '../lib/agents'
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

  return (
    <motion.button
      onClick={() => onSelect(agentId)}
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
