import { motion } from 'framer-motion'

interface MeterBarProps {
  label: string
  value: number
  color: string
  align?: 'left' | 'right'
}

export function MeterBar({ label, value, color, align = 'left' }: MeterBarProps) {
  return (
    <div className="flex-1">
      <div className={'mb-1 flex justify-between font-mono text-[10px] tracking-wider text-slate-500 ' + (align === 'right' ? 'flex-row-reverse' : '')}>
        <span>{label}</span>
        <span className="font-semibold text-slate-300">{value.toFixed(0)}%</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-void-raised">
        <motion.div
          className="h-full rounded-full"
          style={{ backgroundColor: color, boxShadow: `0 0 8px 0 ${color}` }}
          animate={{ width: `${value}%` }}
          transition={{ duration: 0.5, ease: 'easeOut' }}
        />
      </div>
    </div>
  )
}
