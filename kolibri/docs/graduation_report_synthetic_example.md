> Example output of `kolibri graduate --synthetic 12` (synthetic data, real Binance spot fees). Generated in the build environment, which had no access to real market data. It is expected to fail.

# KOLIBRI graduation report

**Verdict: DO NOT GO LIVE**

Config fingerprint `9ccdfa3426f1c855`

| check | value | rule | pass |
|---|---|---|---|
| oos.trades | 0 | >= 300 | ❌ |
| oos.profit_factor | 0.0 | >= 1.3 | ❌ |
| oos.expectancy_r | 0.0 | >= 0.15 | ❌ |
| oos.max_dd_pct | 0.0 | <= 8.0 | ✅ |
| oos.sharpe_daily | 0.0 | >= 1.0 | ❌ |
| oos.fee_ratio | inf | < 0.4 | ❌ |
| oos.positive_windows | 0 | >= 3 | ❌ |
| oos.positive_symbols | 0 | >= 3 | ❌ |
| oos.mc_p95_max_dd_pct | 0.0 | <= 12.0 | ✅ |
| stability.min_expectancy_r | 0.0 | > 0.0 | ❌ |
| paper.days | 0.0 | >= 14 | ❌ |
| paper.trades | 0 | >= 300 | ❌ |
| paper.profit_factor | 0.0 | >= 1.3 | ❌ |
| paper.expectancy_r | 0.0 | >= 0.15 | ❌ |
| paper.max_dd_pct | 0.0 | <= 8.0 | ✅ |
| paper.sharpe_daily | 0.0 | >= 1.0 | ❌ |
| paper.fee_ratio | inf | < 0.4 | ❌ |
