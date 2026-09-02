import type { AgentId, AgentState } from '../types'
import { AGENT_META } from '../lib/agents'
import { AGENT_ICONS } from '../lib/agentIcons'
import { formatPct } from '../lib/format'

interface AgentTileProps {
  agentId: AgentId
  agent: AgentState
  selected: boolean
  onSelect: (id: AgentId) => void
}

export function AgentTile({ agentId, agent, selected, onSelect }: AgentTileProps) {
  const meta = AGENT_META[agentId]
  const Icon = AGENT_ICONS[agentId]

  return (
    <button
      onClick={() => onSelect(agentId)}
      className={
        'flex shrink-0 items-center gap-2 rounded-lg border px-3 py-2 font-mono transition ' +
        (selected
          ? 'border-amber/50 bg-amber/10'
          : 'border-void-border bg-void-raised hover:border-slate-600')
      }
    >
      <Icon size={14} color={meta.color} />
      <div className="flex flex-col items-start leading-tight">
        <span className="text-[10px] font-semibold tracking-wide text-slate-200">{meta.name}</span>
        <span className="text-[9px] text-slate-500">{meta.role}</span>
      </div>
      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: statusColor(agent.status) }} />
      <span className={'text-xs font-bold ' + (agent.value >= 0 ? 'text-profit' : 'text-loss')}>
        {formatPct(agent.value, 1)}
      </span>
    </button>
  )
}

export function statusColor(status: AgentState['status']) {
  switch (status) {
    case 'EXECUTING':
      return '#22c55e'
    case 'SCANNING':
      return '#38bdf8'
    case 'GUARDING':
      return '#ef4444'
    case 'STANDBY':
      return '#eab308'
    default:
      return '#64748b'
  }
}
