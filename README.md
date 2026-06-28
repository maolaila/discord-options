# Discord Web Message Capture

这个工具只做外层监听：它附加到一个开启了本地 Chrome DevTools Protocol 端口的 Chrome 或 Edge 浏览器，然后监听 Discord 网关 WebSocket 收到的消息事件。

它不会控制页面，不会点击、输入、滚动、爬取历史消息，也不会注入脚本。只用于你自己的账号、你有权限查看的服务器或频道。不要记录、转发或共享别人的隐私内容。本工具不会读取浏览器请求头，也不会输出 token、cookie 或 Authorization。

## 项目结构

这是一个 npm workspaces monorepo。根目录保留统一脚本和运行日志，业务入口放在 `apps/`，公共能力放在 `packages/`：

- `apps/discord-capture`: Discord 消息抓包和期权信号识别入口。
- `apps/options-sim`: 期权模拟买入监听和退出监控，只允许模拟账户。
- `apps/stock-rebalance`: 股票月度调仓线，读取目标 CSV 后生成/执行调仓计划。
- `apps/atr-stop`: 股票 ATR 动态止损线，使用确认日线维护本地止损并用实时价触发卖出。
- `apps/control-console`: 本地网页控制台，按业务线展示核心状态。
- `packages/moomoo-opend`: OpenD 连接、行情、账户、下单和日志共享能力。
- `packages/option-signals`: Discord 期权信号解析和信号文档写入。
- `packages/trade-journal`: 期权模拟交易复盘事件日志。

## 安装

```powershell
npm install
Copy-Item .\.env.example .\.env
```

`.env` 是本地配置文件，只放 OpenD 端口、WebSocket 密钥路径、模拟账户参数等机器相关信息，不提交到 GitHub。

## 运行

先启动一个普通 Chrome 或 Edge 窗口，并打开本地 CDP 端口：

```powershell
.\start-discord-cdp.ps1
```

再启动监听程序：

```powershell
npm run capture
```

然后在打开的浏览器窗口里手动打开 Discord 并登录。如果 Discord 已经打开，请在监听程序显示 `Attached` 后刷新 Discord 标签页一次，这样压缩 WebSocket 可以从连接开始被完整监听。

这一步很关键：如果监听器是在 Discord 页面已经连上 gateway WebSocket 之后才启动的，它只能半路看到压缩流，可能无法解码后续实时消息。启动或重启 `npm run capture` 后，都要刷新一次 Discord 页面。

登录状态会保存在 `profile/` 目录里，后续运行一般不需要重新登录。

收到新消息时，终端会打印一行摘要，同时写入：

- `logs/messages.ndjson`: 归一化后的 `MESSAGE_CREATE` 消息记录
- `logs/live-signals.ndjson`: WebSocket 第一时间收到的期权信号
- `logs/option-signals.ndjson`: WebSocket 和 REST 里识别到的期权买卖建议，带 `received_at`、`logged_at` 和延迟字段
- `logs/order-intents.ndjson`: 根据信号生成的纸面下单意图；默认不会连接券商或真实下单
- `signal-docs/YYYY-MM-DD.md`: 按监听收到日期实时追加的可读文档，用来核对延迟和遗漏
- `logs/raw-events.ndjson`: 原始 Discord gateway dispatch 事件
- `logs/history-messages.ndjson`: 你手动翻历史时，所有 `/channels/{id}/messages` 接口返回的消息记录

默认会抓所有频道的历史消息接口，不需要指定频道 ID。你只要在浏览器里手动进入频道、往上翻历史，程序就会记录浏览器收到的这类接口响应：

```text
https://discord.com/api/v9/channels/{channel_id}/messages?before=...&limit=...
```

程序不会主动请求接口，只会从浏览器已经收到的响应里提取消息。

如果你还想临时只记录某个频道，可以加可选过滤：

```powershell
npm run capture -- --channel-id 1467498779497201716
```

## 查看抓到的信息

实时查看消息日志：

```powershell
Get-Content .\logs\messages.ndjson -Wait
```

实时查看 WebSocket 第一时间收到的期权信号：

```powershell
.\watch-live-signals.ps1
```

实时查看当天落库文档：

```powershell
.\watch-signal-doc.ps1
```

查看监听器状态、最后收到的 gateway 事件、最后一条消息和最后一条期权信号：

```powershell
.\show-capture-status.ps1
```

文档里每条期权建议都会写明：

- `message_timestamp`: Discord 消息时间
- `received_at`: 监听器收到网络消息的时间
- `logged_at`: 写入日志/文档的时间
- `message_to_received_lag_ms`: 收到网络消息相对 Discord 消息时间的延迟
- `received_to_logged_lag_ms`: 从监听收到到落库写文档的延迟

实时查看所有历史接口抓取结果：

```powershell
Get-Content .\logs\history-messages.ndjson -Encoding UTF8 -Wait
```

更易读地查看最近 20 条历史接口记录：

```powershell
.\view-channel.ps1
```

只显示某个频道：

```powershell
.\view-channel.ps1 -ChannelId 1467498779497201716
```

实时查看并展开 embed 字段：

```powershell
.\view-channel.ps1 -Wait -Full
```

如果中文仍然乱码，先在当前 PowerShell 窗口运行：

```powershell
.\use-utf8-console.ps1
Get-Content .\logs\messages.ndjson -Wait
```

或者显式指定 UTF-8：

```powershell
Get-Content .\logs\messages.ndjson -Encoding UTF8 -Wait
```

如果文件还不存在，先运行 `npm run capture`。脚本会在监听启动时自动创建空日志文件，并使用 PowerShell 友好的 UTF-8 BOM 编码。

## 常用选项

```powershell
node .\apps\discord-capture\capture-discord.js --all-events
node .\apps\discord-capture\capture-discord.js --rest
node .\apps\discord-capture\capture-discord.js --channel-id 1467498779497201716
node .\apps\discord-capture\capture-discord.js --cdp http://127.0.0.1:9222
node .\apps\discord-capture\capture-discord.js --signal-doc-tz Asia/Tokyo
.\start-discord-cdp.ps1 -BrowserPath "C:\Program Files\Google\Chrome\Application\chrome.exe"
.\start-discord-cdp.ps1 -OpenDiscord
```

- `--all-events`: 记录所有 Discord gateway dispatch 事件，不只记录新消息。
- `--rest`: 额外抓取 Discord REST API JSON 响应体。默认关闭，因为收到实时消息通常走 WebSocket，不走 HTTP 请求。
- `--channel-id`: 可选过滤，只记录这个频道的历史消息接口响应；不传则记录所有频道的历史消息接口响应。
- `--print-all-messages`: 终端同时打印普通聊天消息。默认只打印期权信号，避免交易信号被聊天刷掉。
- `--cdp`: 指定浏览器 CDP 地址，默认 `http://127.0.0.1:9222`。
- `--signal-doc-tz`: 每日文档按哪个时区分日期；也可以设置环境变量 `SIGNAL_DOC_TIMEZONE`。
- `-BrowserPath`: 给启动脚本指定 Chrome 或 Edge 的可执行文件路径。
- `-OpenDiscord`: 启动浏览器时顺便打开 Discord。为了完整抓到压缩 WebSocket，仍建议在监听启动后刷新一次页面。

## 回填已有日志

如果你已经抓到了一批数据，可以重建统一信号日志：

```powershell
node .\rebuild-option-pipeline.js
```

如果还想把已有日志生成一份按日期的回填文档：

```powershell
node .\rebuild-option-pipeline.js --write-docs
```

回填文档会写到 `signal-docs/rebuild-.../YYYY-MM-DD.md`，避免覆盖实时监听正在追加的每日文档。

## Moomoo OpenD 交易计划

本项目可以把已识别的期权买卖建议转换成 moomoo OpenD 交易计划。默认只做 `dry-run`：查询期权链、期权快照、生成限价买入参数并写日志，不会真实下单。

### 一键启动 DC 期权监听控制台

在 PowerShell 里进入项目目录后运行：

```powershell
cd D:\discord-options
.\start-console.ps1
```

脚本会在后台启动网页控制台，并自动打开默认浏览器。控制台地址默认是：

```text
http://127.0.0.1:18766
```

如果只想监听 Discord 期权消息，先在网页控制台点 `Discord 浏览器`，再点 `抓包`。如果要完整跑模拟交易链路，点 `启动全套模拟`，它会启动 Discord CDP 浏览器、抓包监听、OpenD 检查、moomoo 模拟账户买入监听和卖出监控。启动或重启抓包后，等抓包日志出现 `Attached`，再刷新 Discord 页面一次。

控制台默认读取本项目根目录下的 `.env`。如果要临时读取其他位置的配置，可以先设置 `MOOMOO_CONTROL_ENV_FILE` 环境变量，再启动控制台：

```powershell
$env:MOOMOO_CONTROL_ENV_FILE="D:\path\to\old-project\.env"
.\start-console.ps1
```

先检查本机 OpenD 连接和账户列表：

```powershell
npm run moomoo:check
```

如果要复用另一个项目里的 OpenD 配置：

```powershell
npm run moomoo:check -- --env D:\path\to\old-project\.env
```

如果需要验证真实账户“下单后撤单”链路，可以用单独的 smoke test。它只会提交一笔低于参考价的 1 股美股限价 BUY 探针订单，然后立即撤单；脚本默认拒绝在美股常规盘内运行，并要求真实交易三重显式确认：

```powershell
$env:MOOMOO_ALLOW_REAL_TRADING="true"
$env:MOOMOO_REAL_TRADING_CONFIRM="I_UNDERSTAND"
$env:MOOMOO_ORDER_SMOKE_CONFIRM="I_UNDERSTAND"
npm run moomoo:order-smoke -- --symbol AAPL --qty 1 --max-notional 100 --price-ratio 0.35
```

输出会写入：

- `logs/order-smoke-test-latest.json`
- `logs/order-smoke-test.ndjson`

smoke test 会拒绝触碰 `PROTECTED_STOCK_SYMBOLS` 里的股票，例如默认的 `SPCX`。

用某条 Discord 信号生成一份 dry-run 交易计划：

```powershell
npm run moomoo:plan -- --message-id 1512473332728070174
```

持续监听新产生的 `logs/order-intents.ndjson` 并实时生成 dry-run 计划：

```powershell
npm run moomoo:watch-plan
```

输出文件：

- `logs/moomoo-check.json`: OpenD 连接、市场状态、账户列表检查结果
- `logs/moomoo-order-plans.ndjson`: 每条信号的交易计划或拦截原因
- `logs/moomoo-order-plans-latest.json`: 最近一次交易计划，便于人工检查
- `logs/moomoo-executions.ndjson`: 只有显式执行模拟/实盘时才会写入
- `logs/trade-journal.ndjson`: 交易复盘事件流，记录候选计划、买入提交、成交状态、持仓监控快照、退出触发和卖出提交
- `logs/trade-journal-latest.json`: 最近一条复盘事件，便于控制台和人工检查

模拟交易策略默认读取 `config/sim-trading-policy.json`。这是纯本地确定性程序规则，不调用 AI、LLM、OpenAI 或外部模型接口。

当前期权模拟跟单只处理 PA 信号：`执行观点` 必须是交易，`胜率 >= 60`，必须能解析到执行观点里的股票止损价，且 `bull` 只买 Call、`bear` 只买 Put。置信度和风险分数不再作为买入 gate。下单前还会读取 OpenD 正股报价，当前正股价格低于信号止损价时直接拒绝交易。可以在 `.env` 里改：

```text
MOOMOO_REQUIRED_ADVICE_FORMAT=pa
MOOMOO_MIN_WIN_RATE=60
MOOMOO_MIN_CONFIDENCE=
MOOMOO_MAX_RISK_SCORE=
MOOMOO_PAPER_EQUITY_USD=10000
MOOMOO_POSITION_TARGET_PCT=25
MOOMOO_POSITION_MIN_PCT=20
MOOMOO_POSITION_MAX_PCT=30
MOOMOO_OPTION_TAKE_PROFIT_PCT=50
MOOMOO_OPTION_STOP_LOSS_PCT=20
MOOMOO_UNDERLYING_TAKE_PROFIT_PCT=50
MOOMOO_UNDERLYING_STOP_LOSS_PCT=20
MOOMOO_OPTION_EXIT_TAKE_PROFIT_PCT=50
MOOMOO_OPTION_EXIT_STOP_LOSS_PCT=20
MOOMOO_OPTION_MAX_SPREAD_PCT_OF_MID=35
# 可选：固定美元绝对点差门槛；0/false/off/null 表示禁用，当前策略默认禁用
# MOOMOO_OPTION_MAX_SPREAD_ABS=0
MOOMOO_OPTION_MAX_ROUND_TRIP_LOSS_PCT=50
MOOMOO_OPTION_SLIPPAGE_TICKS=1
MOOMOO_OPTION_SLIPPAGE_PCT_OF_SPREAD=10
MOOMOO_OPTION_CAP_QTY_BY_VISIBLE_ASK=true
MOOMOO_OPTION_MAX_QTY_TO_ASK_VOLUME_RATIO=10
```

仓位按期权买入限价和合约乘数计算，目标约为模拟本金的 `25%`，不超过 `30%`。如果因为期权价格导致整数张数不能精确落在 `20%-30%`，计划文件会写明原因。期权成交后默认按期权成交均价执行 `-20%` 止损和 `+50%` 止盈。当前模拟策略允许最多隔日一天：符合受控隔夜条件的仓位可跳过当天收盘卖出，但下一常规交易日 `15:45 ET` 后必须触发收盘退出，`15:55 ET` 后进入强制退出阶段。

期权下单前会先向 OpenD 订阅行情推送：正股使用 `Basic` 推送拿最新价，期权使用 `OrderBook` 推送拿最新 bid/ask；同时会读取一次 `GetSecuritySnapshot` 作为初始快照和兜底，用于 open interest、合约乘数、成交量等字段。SPX 会用 moomoo 的 `.SPX` 查合约链，但不会把 `.SPX` 行情作为下单硬门槛。买入限价不再直接用 `ask`，而是按 `ask + max(1 tick, 10% 点差)` 的保守价格计算；计划文件同时记录 `bid - 滑点` 的卖出估算价和立即往返磨损比例。当前模拟跟单策略不使用固定美元绝对点差拦截高权利金期权，相对点差和即时往返磨损门槛也已放宽，但如果买入限价到可卖估算价的即时损耗已经超过期权止损百分比，会直接跳过，避免买入后第一轮监控立刻止损。基础拦截还包括 bid/ask 缺失、明显过宽相对点差、明显过高往返损耗、open interest 和当日成交量。目标张数如果明显超过可见 ask 挂单量，会按 `askVol * 10` 限制张数，并在 `position_sizing.reasons` 写明。

模拟执行需要显式传参：

```powershell
npm run moomoo:simulate -- --message-id 1512473332728070174
```

持续监听新信号并提交模拟账户订单：

```powershell
npm run moomoo:watch-sim
```

模拟账户卖出监控：

```powershell
npm run moomoo:exit-watch
```

控制台里的 `启动全套模拟` 会同时启动买入监听和卖出监控。卖出监控只处理本程序提交且已经成交的同环境买入单；触发有效股票目标价/股票止损价、期权成交价 `-20%/+50%`、或收盘前退出时，按当前期权 `bid - 滑点` 的保守限价提交 `SELL_TO_CLOSE` 单。收盘退出使用纽约时间：`15:45 ET` 开始主动退出，`15:55 ET` 后进入强制退出阶段并使用更积极但仍受最小 tick 保护的限价；如果持仓符合受控隔夜条件，监控会记录 `controlled_overnight_hold` 并跳过当日收盘卖出，下一常规交易日收盘窗口触发 `controlled_overnight_next_day_exit`。行情触发采用 OpenD 推送缓存优先，订单/持仓状态默认每 `5` 秒向 OpenD 校验一次，避免触发未完成订单查询限频。卖出记录写入 `logs/moomoo-exit-orders.ndjson`，状态写入 `logs/moomoo-exit-status.json`。

每个交易生命周期都会额外写入 `logs/trade-journal.ndjson`，用于后续人工复盘或本地整理后给 AI 参考。该文件是追加式 JSONL，每行包含：

- Discord 信号：消息 ID、频道、发送时间、收到时间、ticker、到期日、行权价、方向、胜率、置信、风险。
- 策略快照：当前筛选门槛、仓位比例、止盈止损百分比、点差/滑点/流动性阈值。
- 入场决策：期权合约、bid/ask/mid、买入限价、卖出估算价、即时往返磨损、open interest、当日成交量、仓位张数和金额。
- 风控线：期权成交价 `20%/50%` 出场纪律、股票线是否有效、信号自带股票目标价/止损价、收盘前退出窗口，以及受控隔夜豁免参数。
- 执行过程：买入订单 ID、成交状态、成交均价、可卖数量、持仓快照、监控时的标的价和期权报价。
- 退出过程：触发原因、卖出限价、卖出订单 ID、预估期权 PnL。

这些复盘数据只落本地 `logs/`，不会提交 GitHub，也不会自动发送给外部 AI 或模型服务。真实盘如果以后启用，券商真实成交回报仍然是最终依据；journal 里的点差、滑点和预估 PnL 只作为复盘参考。

`--execute-simulate` 会自动从 OpenD 账户列表中选择 `trdEnv=0`、支持美股市场、且模拟账户类型支持期权的账户；不会使用 `.env` 里的真实账户 ID。

期权业务线现在只允许模拟账户执行。`apps/options-sim/moomoo-signal-trader.mjs` 和 `apps/options-sim/moomoo-exit-monitor.mjs` 遇到 `--execute-real` 会直接拒绝；真实账户操作只放在股票调仓和 ATR 止损两条独立业务线。

当前点差、滑点、可见 ask 流动性和立即往返磨损模型用于模拟盘和交易计划的保守估算。真实盘不会把这些估算当成真实成交价；真实成交必须以真实市场和券商实际成交回报为准。bid、ask 和 mid 只作为开仓/平仓限价和成交质量的参考。

## 三条独立业务线

控制台仍用同一个入口：

```powershell
.\start-console.ps1
```

页面里可以分别启动和停止：

- 期权模拟：`全套模拟` / `停止全部`
- 股票实盘调仓：`调仓计划`、`执行调仓` / `停调仓`
- ATR 实盘止损：`刷新 ATR`、`确认监控` / `停 ATR`

三条线除了 OpenD 连接封装以外，不共用交易状态文件。期权线只走模拟账户；股票调仓和 ATR 监控是实盘业务线，仍要求 `.env` 里 `MOOMOO_ALLOW_REAL_TRADING=true`，否则确认执行/确认监控后会拒绝下单。`刷新 ATR` 只读取实盘持仓和行情计算点位，不提交订单。

默认保护标的是 `SPCX`：`PROTECTED_STOCK_SYMBOLS=SPCX`。保护标的不会被股票调仓卖出/买入、不会被 ATR 止损线监控卖出，也不会被真实挂单 smoke test 使用。这个仓位按长期持有处理。

### 股票仓位调仓

本地表格是项目根目录下的 `stock-rebalance-targets.csv`，不要提交。格式参考 `stock-rebalance-targets.example.csv`：

```csv
symbol,target_pct
AAPL,20
MSFT,20
NVDA,20
GOOGL,20
AMZN,20
```

规则：

- 必须正好 5 个美股股票标的，默认每个 `20%`。
- 只按整股配平，不买碎股。
- 如果目标表格和当前持仓一致，只做配平买卖。
- 如果当前持仓里有目标表格之外的股票，先生成清仓卖单，再生成目标股票买入/配平买卖。
- `PROTECTED_STOCK_SYMBOLS` 里的股票不参与调仓；即使不在目标表里，也不会生成卖单。
- dashboard 里先点 `刷新计划`，控制台会显示最新预计卖出/买入标的、数量、目标仓位和保护仓位。
- 检查计划无误后，再点 `确认执行` 启动开盘监听执行程序；按钮会二次确认，避免误点直接下单。
- 到美股常规盘开盘后，会按最新持仓、资金和报价重算一次卖出计划，先提交全部市价卖单。
- 卖出阶段默认最多等待 `120s`。只有所有卖出计划都确认完全成交后，才会刷新持仓/资金/报价并重算买入计划。
- 买入阶段提交市价买单，主要目标是成交；如果卖出阶段失败、取消、超时或未完全成交，买入阶段会跳过并等待人工确认或下次调仓。

命令行：

```powershell
npm run stock:rebalance-plan
npm run stock:rebalance-live
```

输出：

- `logs/stock-rebalance-status.json`
- `logs/stock-rebalance-plan-latest.json`
- `logs/stock-rebalance-orders.ndjson`

### ATR 实盘移动止损

ATR 业务线只负责当前实盘美股持仓的止损，不负责选股，也不读取股票调仓表。

规则：

- 日线 ATR(21)，Wilder 平滑。
- ATR 倍数 `3.5`。
- 使用买入后最高日线收盘价作为跟踪基准。
- 止损线 `highest_close_since_entry - 3.5 * ATR(21)`，只能上移，不能下移。
- 只用确认后的日线 close 更新最高收盘价，不使用盘中最高价。
- 实时价格 `<= current_stop_price` 时，卖出该股票全部可卖持仓。
- 触发后先提交可成交限价卖单，默认按实时价下方 `0.35%` 做保护限价；`30-60s` 内未成交时，按剩余可卖股数提交市价兜底单。
- 已触发 `PENDING_SELL` 或 `SOLD` 的股票不会重复发首单；成交或仓位消失后状态落到 `SOLD`。
- `PROTECTED_STOCK_SYMBOLS` 里的股票会显示为 `PROTECTED`，不会计算/触发 ATR 卖出。
- `logs/atr-stop-state.json` 会记录当前持仓、ATR 点数、止损价、离止损百分比、当前盈亏和盈亏比例，控制台直接读取这些字段。
- dashboard 里先点 `刷新 ATR`，控制台会按当前实盘持仓标的、最近一个已确认日线收盘重新计算 ATR 点位并显示；检查无误后，再点 `确认监控` 启动实盘止损监听。

命令行：

```powershell
npm run atr:stop-refresh
npm run atr:stop-watch
```

输出：

- `logs/atr-stop-status.json`
- `logs/atr-stop-state.json`
- `logs/atr-stop-orders.ndjson`

## 说明

网页版 Discord 收到实时消息通常不是一个新的 HTTP 请求，而是 gateway WebSocket 的 `MESSAGE_CREATE` 事件。所以这个程序抓的是浏览器里的 WebSocket 收帧内容。

## 提交和迁移边界

可以提交到 GitHub 的内容：

- 程序源码、PowerShell 启动脚本、`package.json`、`package-lock.json`
- `.env.example`、`config/sim-trading-policy.json`
- `vendor/MMAPI4JS_10.6.6608/`，这是本项目运行 moomoo OpenD 所需的本地 JS SDK
- `NEW_DEVICE_SETUP.md` 和其他说明文档

不要提交的本地内容：

- `.env`、`.env.*`、`secrets/`
- `logs/`
- `profile/`
- `signal-docs/`
- `analysis/`

换设备步骤见 `NEW_DEVICE_SETUP.md`。
