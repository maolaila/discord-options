# Discord Web Message Capture

这个工具只做外层监听：它附加到一个开启了本地 Chrome DevTools Protocol 端口的 Chrome 或 Edge 浏览器，然后监听 Discord 网关 WebSocket 收到的消息事件。

它不会控制页面，不会点击、输入、滚动、爬取历史消息，也不会注入脚本。只用于你自己的账号、你有权限查看的服务器或频道。不要记录、转发或共享别人的隐私内容。本工具不会读取浏览器请求头，也不会输出 token、cookie 或 Authorization。

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
node .\capture-discord.js --all-events
node .\capture-discord.js --rest
node .\capture-discord.js --channel-id 1467498779497201716
node .\capture-discord.js --cdp http://127.0.0.1:9222
node .\capture-discord.js --signal-doc-tz Asia/Tokyo
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

启动本地控制台页面：

```powershell
.\start-console.ps1
```

控制台地址默认是：

```text
http://127.0.0.1:18766
```

控制台里的 `启动全套模拟` 会启动 Discord CDP 浏览器、抓包监听、OpenD 检查和 moomoo 模拟账户监听。启动或重启抓包后，等抓包日志出现 `Attached`，再刷新 Discord 页面一次。

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

模拟交易策略默认读取 `sim-trading-policy.json`。这是纯本地确定性程序规则，不调用 AI、LLM、OpenAI 或外部模型接口。

当前自动交易门槛是：`PA only`、`胜率 >= 80`、`置信 >= 5`、`风险 <= 2`、必须有股票入场/目标/止损，且 `bull` 只买 Call、`bear` 只买 Put。可以在 `.env` 里改：

```text
MOOMOO_REQUIRED_ADVICE_FORMAT=pa
MOOMOO_MIN_WIN_RATE=80
MOOMOO_MIN_CONFIDENCE=5
MOOMOO_MAX_RISK_SCORE=2
MOOMOO_PAPER_EQUITY_USD=10000
MOOMOO_POSITION_TARGET_PCT=25
MOOMOO_POSITION_MIN_PCT=20
MOOMOO_POSITION_MAX_PCT=30
MOOMOO_UNDERLYING_TAKE_PROFIT_PCT=50
MOOMOO_UNDERLYING_STOP_LOSS_PCT=20
MOOMOO_OPTION_MAX_SPREAD_PCT_OF_MID=25
MOOMOO_OPTION_MAX_ROUND_TRIP_LOSS_PCT=40
MOOMOO_OPTION_SLIPPAGE_TICKS=1
MOOMOO_OPTION_SLIPPAGE_PCT_OF_SPREAD=10
MOOMOO_OPTION_CAP_QTY_BY_VISIBLE_ASK=true
MOOMOO_OPTION_MAX_QTY_TO_ASK_VOLUME_RATIO=10
```

仓位按期权买入限价和合约乘数计算，目标约为模拟本金的 `25%`，不超过 `30%`。如果因为期权价格导致整数张数不能精确落在 `20%-30%`，计划文件会写明原因。止盈止损的百分比基准是买入期权时对应股票的价格，不是期权价格；同时仍记录信号自带的股票目标价和止损价。

期权下单前会先向 OpenD 订阅行情推送：正股使用 `Basic` 推送拿最新价，期权使用 `OrderBook` 推送拿最新 bid/ask；同时会读取一次 `GetSecuritySnapshot` 作为初始快照和兜底，用于 open interest、合约乘数、成交量等字段。买入限价不再直接用 `ask`，而是按 `ask + max(1 tick, 10% 点差)` 的保守价格计算；计划文件同时记录 `bid - 滑点` 的卖出估算价和立即往返磨损比例。如果点差超过配置阈值、即时往返磨损过大、bid/ask 缺失、open interest 或当日成交量过低，计划会被拦截。目标张数如果明显超过可见 ask 挂单量，会按 `askVol * 10` 限制张数，并在 `position_sizing.reasons` 写明。

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

控制台里的 `启动全套模拟` 会同时启动买入监听和卖出监控。卖出监控只处理本程序提交且已经成交的同环境买入单；触发股票目标价、股票止损价、标的价格百分比止盈/止损或收盘前退出时，按当前期权 `bid - 滑点` 的保守限价提交 `SELL_TO_CLOSE` 单。行情触发采用 OpenD 推送缓存优先，订单/持仓状态仍每 `2` 秒向 OpenD 校验一次。卖出记录写入 `logs/moomoo-exit-orders.ndjson`，状态写入 `logs/moomoo-exit-status.json`。

每个交易生命周期都会额外写入 `logs/trade-journal.ndjson`，用于后续人工复盘或本地整理后给 AI 参考。该文件是追加式 JSONL，每行包含：

- Discord 信号：消息 ID、频道、发送时间、收到时间、ticker、到期日、行权价、方向、胜率、置信、风险。
- 策略快照：当前筛选门槛、仓位比例、止盈止损百分比、点差/滑点/流动性阈值。
- 入场决策：期权合约、bid/ask/mid、买入限价、卖出估算价、即时往返磨损、open interest、当日成交量、仓位张数和金额。
- 风控线：以买入时标的股票价为基准的百分比止盈/止损线，以及信号自带股票目标价/止损价。
- 执行过程：买入订单 ID、成交状态、成交均价、可卖数量、持仓快照、监控时的标的价和期权报价。
- 退出过程：触发原因、卖出限价、卖出订单 ID、预估期权 PnL。

这些复盘数据只落本地 `logs/`，不会提交 GitHub，也不会自动发送给外部 AI 或模型服务。真实盘如果以后启用，券商真实成交回报仍然是最终依据；journal 里的点差、滑点和预估 PnL 只作为复盘参考。

`--execute-simulate` 会自动从 OpenD 账户列表中选择 `trdEnv=0`、支持美股市场、且模拟账户类型支持期权的账户；不会使用 `.env` 里的真实账户 ID。

实盘执行还有额外三重开关：`.env` 里 `MOOMOO_ALLOW_REAL_TRADING=true`，当前环境变量 `MOOMOO_REAL_TRADING_CONFIRM=I_UNDERSTAND`，并且命令行传 `--execute-real`。不满足这些条件时，买入监听和卖出监控都会直接拒绝实盘下单。

完整实盘链路需要同时启动买入监听和卖出监控：

```powershell
$env:MOOMOO_REAL_TRADING_CONFIRM="I_UNDERSTAND"
npm run moomoo:watch-real
npm run moomoo:exit-real-watch
```

实盘命令不会自动选择模拟账户；会使用 `.env` 里的 `MOOMOO_ACC_ID`，并在 OpenD 账户列表中验证它是支持美股市场的实盘账户。

当前点差、滑点、可见 ask 流动性和立即往返磨损模型用于模拟盘和交易计划的保守估算。真实盘不会把这些估算当成真实成交价；真实成交必须以真实市场和券商实际成交回报为准。bid、ask 和 mid 只作为开仓/平仓限价和成交质量的参考。

## 说明

网页版 Discord 收到实时消息通常不是一个新的 HTTP 请求，而是 gateway WebSocket 的 `MESSAGE_CREATE` 事件。所以这个程序抓的是浏览器里的 WebSocket 收帧内容。

## 提交和迁移边界

可以提交到 GitHub 的内容：

- 程序源码、PowerShell 启动脚本、`package.json`、`package-lock.json`
- `.env.example`、`sim-trading-policy.json`
- `vendor/MMAPI4JS_10.6.6608/`，这是本项目运行 moomoo OpenD 所需的本地 JS SDK
- `NEW_DEVICE_SETUP.md` 和其他说明文档

不要提交的本地内容：

- `.env`、`.env.*`、`secrets/`
- `logs/`
- `profile/`
- `signal-docs/`
- `analysis/`

换设备步骤见 `NEW_DEVICE_SETUP.md`。
