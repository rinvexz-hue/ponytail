import { useMemo } from 'react'
import { Bar, BarChart, CartesianGrid, Cell, ComposedChart, Line, ResponsiveContainer, XAxis, YAxis } from 'recharts'
import { useSwarmStore } from '../store'
import { formatUsd } from '../lib/format'

const GREEN = '#22c55e'
const RED = '#ef4444'
const AMBER = '#f59e0b'

function formatTick(time: number) {
  return new Date(time).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
}

interface CandleShapeProps {
  x?: number
  y?: number
  width?: number
  height?: number
  payload?: { open: number; close: number; low: number; high: number }
}

function CandleShape(rawProps: unknown) {
  const { x = 0, y = 0, width = 0, height = 0, payload } = rawProps as CandleShapeProps
  if (!payload) return <g />
  const { open, close, low, high } = payload
  const range = high - low || 1
  const scaleY = (v: number) => y + height - ((v - low) / range) * height
  const openY = scaleY(open)
  const closeY = scaleY(close)
  const isUp = close >= open
  const color = isUp ? GREEN : RED
  const bodyY = Math.min(openY, closeY)
  const bodyH = Math.max(1.5, Math.abs(closeY - openY))
  const wickX = x + width / 2
  const bodyW = Math.max(2, width * 0.62)
  const bodyX = x + (width - bodyW) / 2

  return (
    <g>
      <line x1={wickX} x2={wickX} y1={y} y2={y + height} stroke={color} strokeWidth={1} />
      <rect x={bodyX} y={bodyY} width={bodyW} height={bodyH} fill={color} rx={1} />
    </g>
  )
}

function BalanceLabelDot(props: any) {
  const { cx, cy, index, payload, viewBox } = props
  const isLast = payload?.isLast
  if (!isLast || cx == null || cy == null) return null
  const chartWidth = viewBox?.width ?? 0
  const label = formatUsd(payload.close, { compact: true })
  const labelWidth = 14 + label.length * 6.5
  const flip = cx + labelWidth + 8 > chartWidth
  const boxX = flip ? cx - labelWidth - 8 : cx + 8

  return (
    <g key={`balance-label-${index}`}>
      <circle cx={cx} cy={cy} r={3} fill={AMBER} stroke="#0a0a0f" strokeWidth={1.5} />
      <rect x={boxX} y={cy - 10} width={labelWidth} height={20} rx={4} fill="#15151f" stroke={AMBER} strokeOpacity={0.5} />
      <text
        x={boxX + labelWidth / 2}
        y={cy + 4}
        textAnchor="middle"
        fontSize={11}
        fontFamily="JetBrains Mono, monospace"
        fontWeight={700}
        fill={AMBER}
      >
        {label}
      </text>
    </g>
  )
}

export function BalanceChart() {
  const candles = useSwarmStore((s) => s.candles)
  const movingAverage = useSwarmStore((s) => s.movingAverage)

  const data = useMemo(
    () =>
      candles.map((c, i) => ({
        ...c,
        range: [c.low, c.high] as [number, number],
        ma: movingAverage[i],
        isLast: i === candles.length - 1,
      })),
    [candles, movingAverage],
  )

  if (data.length === 0) return null

  return (
    <div className="flex flex-col">
      <div style={{ height: 260 }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 10, right: 56, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="#23232f" strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="time" hide tickFormatter={formatTick} />
            <YAxis domain={['dataMin', 'dataMax']} hide />
            <Bar dataKey="range" shape={CandleShape} isAnimationActive={false} />
            <Line
              dataKey="ma"
              stroke={AMBER}
              strokeWidth={1.5}
              dot={false}
              isAnimationActive={false}
              strokeOpacity={0.8}
            />
            <Line dataKey="close" stroke="none" dot={<BalanceLabelDot />} isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div style={{ height: 56 }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 0, right: 56, bottom: 0, left: 0 }}>
            <XAxis
              dataKey="time"
              tickFormatter={formatTick}
              tick={{ fontSize: 9, fill: '#52525b', fontFamily: 'JetBrains Mono, monospace' }}
              axisLine={{ stroke: '#23232f' }}
              tickLine={false}
              interval="preserveStartEnd"
            />
            <YAxis hide domain={[0, 'dataMax']} />
            <Bar dataKey="volume" isAnimationActive={false} radius={[1, 1, 0, 0]}>
              {data.map((d, i) => (
                <Cell key={i} fill={d.close >= d.open ? GREEN : RED} fillOpacity={0.55} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
