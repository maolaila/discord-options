# Option Backtest Data Requirements

当前已经可以从 Discord 历史消息和实时消息里整理出期权信号，但严谨回测需要额外市场数据，不能用消息里的股票入场价替代期权成交价。

## 已整理出的信号字段

- `timestamp_second`: Discord 消息发送时间，UTC 秒级。
- `ticker`: 标的股票。
- `expiration`: 期权到期日。
- `strike`: 行权价。
- `option_type`: `C` 或 `P`。
- `polygon_option_ticker`: Polygon 可用的期权代码格式，例如 `O:DOCU260515C00050000`。
- `entry_stock_price` / `target_stock_price` / `stop_stock_price`: 消息里的股票价位，不是期权价格。
- `win_rate_pct`: 消息里的胜率字段。

## 精确回测所需数据

每条信号需要：

- 对应期权合约从消息时间到当日收盘的分钟级 OHLC，最好是逐笔成交和 NBBO。
- 对应股票从消息时间到当日收盘的分钟级 OHLC，最好是逐笔或 NBBO。
- 当天市场时区与常规交易收盘时间。美股常规交易日通常按 `America/New_York`，收盘 `16:00`。

## 回测规则

- 买入时间：收到消息后的 2 分钟内，使用可成交的期权价格。
- 止盈止损触发基准：买入期权时对应股票的价格，不是期权价格。
- 股票百分比止盈：标的价格相对买入时股票价，朝信号方向移动 `50%`。
- 股票百分比止损：标的价格相对买入时股票价，逆信号方向移动 `20%`。
- 信号目标止盈：bull 信号股票涨到 `target_stock_price` 或更高；bear 信号股票跌到 `target_stock_price` 或更低。
- 信号止损：bull 信号股票跌到 `stop_stock_price` 或更低；bear 信号股票涨到 `stop_stock_price` 或更高。
- 如果没有触发止盈/止损，收盘前卖出，不隔夜。

## 数据源状态

如果提供 `POLYGON_API_KEY`，可以运行：

```powershell
$env:POLYGON_API_KEY="你的key"
node .\backtest-option-signals-polygon.js
```

该脚本会读取本地 `analysis/option_signals_winrate_ge_75_dedup.json`，并输出：

- `analysis/option_backtest_polygon_results.json`
- `analysis/option_backtest_polygon_trades.csv`

注意：分钟级 OHLC 只能近似成交，不能解决同一分钟内先触发止盈还是先触发止损的精确排序问题。若要精确到秒级或逐笔成交，需要期权逐笔 trades 或 NBBO 数据。
