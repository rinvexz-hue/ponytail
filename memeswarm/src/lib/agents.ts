import type { AgentId, AgentMeta } from '../types'

export const AGENT_IDS: AgentId[] = [
  'scout',
  'sniper',
  'sentiment',
  'whalewatch',
  'liquidity',
  'risk',
  'exit',
  'treasury',
]

export const AGENT_META: Record<AgentId, AgentMeta> = {
  scout: {
    id: 'scout',
    name: 'SCOUT',
    role: 'Launch Scanner',
    color: '#38bdf8',
    glow: 'rgba(56,189,248,0.45)',
  },
  sniper: {
    id: 'sniper',
    name: 'SNIPER',
    role: 'Fast Entry',
    color: '#22c55e',
    glow: 'rgba(34,197,94,0.45)',
  },
  sentiment: {
    id: 'sentiment',
    name: 'SENTIMENT',
    role: 'Hype Scanner',
    color: '#a855f7',
    glow: 'rgba(168,85,247,0.45)',
  },
  whalewatch: {
    id: 'whalewatch',
    name: 'WHALE-WATCH',
    role: 'On-Chain Tracker',
    color: '#06b6d4',
    glow: 'rgba(6,182,212,0.45)',
  },
  liquidity: {
    id: 'liquidity',
    name: 'LIQUIDITY',
    role: 'Depth Monitor',
    color: '#eab308',
    glow: 'rgba(234,179,8,0.45)',
  },
  risk: {
    id: 'risk',
    name: 'RISK',
    role: 'Rug Detection',
    color: '#ef4444',
    glow: 'rgba(239,68,68,0.45)',
  },
  exit: {
    id: 'exit',
    name: 'EXIT',
    role: 'TP / SL Desk',
    color: '#f97316',
    glow: 'rgba(249,115,22,0.45)',
  },
  treasury: {
    id: 'treasury',
    name: 'TREASURY',
    role: 'Settlement',
    color: '#f59e0b',
    glow: 'rgba(245,158,11,0.45)',
  },
}

// One-sentence explanations shown on hover in SWARM CORE — what each agent
// actually does, separate from the others, in plain language.
export const AGENT_DESCRIPTIONS: Record<AgentId, string> = {
  scout: 'Scans for freshly launched tokens and new liquidity pools the moment they appear on-chain.',
  sniper: 'Fires the entry trade once SCOUT, SENTIMENT and WHALE-WATCH agree the setup is worth it.',
  sentiment: 'Tracks social buzz and hype spikes for each token across crypto social media.',
  whalewatch: 'Watches large wallets for accumulation or exit patterns that hint at where price is headed.',
  liquidity: 'Monitors pool depth and sizes trades to avoid excessive slippage on thin books.',
  risk: 'Screens contracts for rug-pull red flags and can veto an entry or force-close a position.',
  exit: 'Runs the stop-loss and trailing-stop discipline that decides when a position closes.',
  treasury: 'Settles fills, rebalances funds across venues, and sweeps profit.',
}

export const TICKER_SYMBOLS = ['PEPE', 'WIF', 'BONK', 'FLOKI', 'POPCAT', 'MEW', 'BRETT', 'TURBO']
