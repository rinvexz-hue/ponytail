import './store'
import { TickerBar } from './components/TickerBar'
import { Header } from './components/Header'
import { KpiRow } from './components/KpiRow'
import { PositionsPanel } from './components/PositionsPanel'
import { TradingPanel } from './components/TradingPanel'
import { SwarmCore } from './components/SwarmCore'
import { AlignmentBar } from './components/AlignmentBar'
import { BacktestPanel } from './components/BacktestPanel'
import { KrakenPanel } from './components/KrakenPanel'

export default function App() {
  return (
    <div className="min-h-screen bg-void">
      <TickerBar />
      <Header />
      <main>
        <KpiRow />
        <PositionsPanel />
        <TradingPanel />
        <SwarmCore />
        <AlignmentBar />
        <BacktestPanel />
        <KrakenPanel />
      </main>
    </div>
  )
}
