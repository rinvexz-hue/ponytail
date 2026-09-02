import { animate, motion, useMotionValue, useTransform } from 'framer-motion'
import { useEffect } from 'react'

interface AnimatedNumberProps {
  value: number
  format: (v: number) => string
  className?: string
  duration?: number
}

export function AnimatedNumber({ value, format, className, duration = 0.6 }: AnimatedNumberProps) {
  const motionValue = useMotionValue(value)
  const display = useTransform(motionValue, (latest) => format(latest))

  useEffect(() => {
    const controls = animate(motionValue, value, { duration, ease: 'easeOut' })
    return controls.stop
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  return (
    <motion.span className={className} style={{ fontVariantNumeric: 'tabular-nums' }}>
      {display}
    </motion.span>
  )
}
