# 换设备运行指引

这份指引用于把项目克隆到另一台 Windows 电脑后重新跑起来。仓库只提交代码、示例配置和 Moomoo OpenD JavaScript SDK；真实日志、Discord 登录 profile、OpenD 密钥、账户号和模拟交易记录都不提交，需要在新设备本地重新配置。

## 需要提前安装

- Git
- Node.js LTS
- Chrome 或 Edge
- Moomoo 桌面端和 OpenD，并确认 OpenD 已登录、已开启 WebSocket API

## 克隆和安装

```powershell
git clone https://github.com/maolaila/discord-options.git
cd discord-options
npm install
```

## 创建本地配置

```powershell
Copy-Item .\.env.example .\.env
notepad .\.env
```

至少检查这些项：

```text
MOOMOO_OPEND_HOST=127.0.0.1
MOOMOO_OPEND_WS_PORT=33333
MOOMOO_OPEND_WS_SSL=false
MOOMOO_OPEND_WS_KEY=
MOOMOO_OPEND_WS_KEY_FILE=./secrets/moomoo_opend_ws_key.txt
MOOMOO_TRD_ENV=simulate
MOOMOO_TRD_MARKET=US
MOOMOO_QUOTE_PUSH_WARMUP_MS=350
MOOMOO_QUOTE_FALLBACK_SNAPSHOT_MAX_AGE_MS=2000
MOOMOO_ALLOW_REAL_TRADING=false
```

如果 OpenD 设置了 WebSocket 连接密钥，把密钥放到本地文件：

```powershell
New-Item -ItemType Directory -Force .\secrets
notepad .\secrets\moomoo_opend_ws_key.txt
```

不要把 `.env`、`secrets/`、`logs/`、`profile/`、`analysis/` 或 `signal-docs/` 提交到 GitHub。

## 检查 OpenD

先启动 Moomoo 和 OpenD，然后运行：

```powershell
npm run moomoo:check
```

输出里应看到：

- `OpenD connection: OK`
- `qotLogined=true`
- `trdLogined=true`
- 至少一个 `trdEnv=0` 且支持 US 市场的模拟账户

如果想临时复用旧项目里的配置，可以这样运行，但不需要把旧项目文件复制进仓库：

```powershell
npm run moomoo:check -- --env D:\path\to\old-project\.env
```

## 启动控制台

```powershell
.\start-console.ps1
```

浏览器会打开：

```text
http://127.0.0.1:18766
```

点 `启动全套模拟` 后，控制台会启动：

- Discord CDP 浏览器
- Discord 网络监听
- Moomoo OpenD 检查
- 模拟账户买入监听
- 模拟账户卖出监控

等抓包日志显示 `Attached` 后，刷新 Discord 页面一次。之后只要网页版 Discord 收到符合条件的期权信号，程序会实时落本地日志并按模拟账户规则处理。

## 本地数据会重新生成

以下目录是本地运行数据，不随仓库迁移：

- `profile/`: 浏览器登录状态。新设备需要重新登录 Discord。
- `logs/`: 抓包消息、计划、模拟订单、状态。
- `signal-docs/`: 每日信号文档。
- `analysis/`: 历史整理和回测输出。
- `secrets/`: OpenD WebSocket 密钥等本地密钥。

## 安全边界

默认只允许模拟交易。实盘需要同时满足代码里的多重开关：`.env` 里 `MOOMOO_ALLOW_REAL_TRADING=true`、环境变量 `MOOMOO_REAL_TRADING_CONFIRM=I_UNDERSTAND`，并且命令行传 `--execute-real`。没有明确授权前，不要开启这些开关。
