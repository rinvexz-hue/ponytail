import { Crosshair, Droplets, Eye, LogOut, MessageSquare, Radar, ShieldAlert, Wallet } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { AgentId } from '../types'

export const AGENT_ICONS: Record<AgentId, LucideIcon> = {
  scout: Radar,
  sniper: Crosshair,
  sentiment: MessageSquare,
  whalewatch: Eye,
  liquidity: Droplets,
  risk: ShieldAlert,
  exit: LogOut,
  treasury: Wallet,
}
