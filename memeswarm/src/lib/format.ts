export function formatUsd(value: number, opts: { compact?: boolean } = {}): string {
  const abs = Math.abs(value)
  if (opts.compact && abs >= 1000) {
    return (value < 0 ? '-$' : '$') + compactNumber(abs)
  }
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

export function compactNumber(value: number): string {
  const abs = Math.abs(value)
  if (abs >= 1_000_000_000) return (value / 1_000_000_000).toFixed(2) + 'B'
  if (abs >= 1_000_000) return (value / 1_000_000).toFixed(2) + 'M'
  if (abs >= 1_000) return (value / 1_000).toFixed(1) + 'K'
  return value.toFixed(0)
}

export function formatPct(value: number, digits = 2): string {
  const sign = value > 0 ? '+' : ''
  return `${sign}${value.toFixed(digits)}%`
}

export function formatSigned(value: number): string {
  const sign = value >= 0 ? '+' : '-'
  return `${sign}${formatUsd(Math.abs(value))}`
}

export function formatPrice(value: number): string {
  if (value < 0.01) return value.toFixed(8)
  if (value < 1) return value.toFixed(5)
  return value.toFixed(2)
}

export function formatUptime(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const hh = Math.floor(totalSeconds / 3600)
  const mm = Math.floor((totalSeconds % 3600) / 60)
  const ss = totalSeconds % 60
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}`
}
