import './store'
import { TickerBar } from './components/TickerBar'
import { Header } from './components/Header'
import { KpiRow } from './components/KpiRow'
import { TradingPanel } from './components/TradingPanel'
import { SwarmCore } from './components/SwarmCore'
import { AlignmentBar } from './components/AlignmentBar'

export default function App() {
  return (
    <div className="min-h-screen bg-void">
      <TickerBar />
      <Header />
      <main>
        <KpiRow />
        <TradingPanel />
        <SwarmCore />
        <AlignmentBar />
      </main>
    </div>
  )
}
