import { motion } from 'framer-motion'
import { useSwarmStore } from '../store'

export function AlignmentBar() {
  const alignment = useSwarmStore((s) => s.alignment)

  return (
    <div className="px-4 pb-6 sm:px-6">
      <div className="rounded-lg border border-void-border bg-void-panel p-4 shadow-panel">
        <div className="mb-2 flex items-center justify-between font-mono text-xs">
          <span className="font-semibold tracking-widest text-slate-400">SWARM ALIGNMENT</span>
          <span className="font-bold text-slate-100" style={{ fontVariantNumeric: 'tabular-nums' }}>
            {alignment.toFixed(1)}%
          </span>
        </div>
        <div className="relative h-2.5 w-full overflow-hidden rounded-full bg-void-raised">
          <div
            className="absolute inset-0"
            style={{ background: 'linear-gradient(90deg, #ef4444 0%, #eab308 50%, #22c55e 100%)' }}
          />
          <motion.div
            className="absolute inset-y-0 right-0 bg-void-panel"
            animate={{ width: `${100 - alignment}%` }}
            transition={{ duration: 0.6, ease: 'easeOut' }}
          />
        </div>
      </div>
    </div>
  )
}
