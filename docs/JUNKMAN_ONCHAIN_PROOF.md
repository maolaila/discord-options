# JUNKMAN Base 链上交易证明

这套发布器与交易程序完全隔离。它只读取已经写入
`logs/zero-dte-options-trades.ndjson` 的完整模拟平仓记录，不导入 OpenD，
不连接交易账户，也不会启动、停止或修改任何 watcher。

## 发布内容

- 只接受 `business_line=zero-dte-options`；
- 只接受 `execution_environment=simulate_only`；
- 只接受字段完整的 `experiment_line_position_closed`；
- 每条止盈止损线生成独立 canonical leaf；
- 所有尚未发布的 leaf 合成一个确定性的 Merkle 根；
- Base 链上只写入策略 ID 哈希、记录 ID、批次数据哈希、来源时间和 schema；
- 交易明细、收益数字和本地日志不会作为 calldata 上传。

本地 canonical 批次保存在 `onchain-data/canonical/`，链上交易索引保存在
`onchain-data/chain-index.json`。这两类脱敏证明数据可以提交 Git，钱包私钥、
RPC 凭证、OpenD 密钥和原始日志都不能提交。

当前复用已经部署的 `TrackRecordLedgerLite` 合约。合约源码副本位于
`apps/trade-notary/contracts/TrackRecordLedgerLite.sol`，链上 `RecordCommitted`
事件是最终证明。canonical 文件必须和链上索引一起保存，否则链上哈希本身
无法还原交易明细。

## 使用

收益报表页面的“一键上链”按钮会先检查本地增量、钱包所有权和预估 Gas，
再发送一笔 Base 交易。没有新增记录时不会发送交易或消耗 Gas。

```powershell
npm run onchain:status
npm run onchain:dry-run
npm run onchain:publish
```

浏览器按钮只允许从 `http://127.0.0.1:18766/junkman-performance.html`
调用；直接以 `file://` 打开时只允许查看报表，不能触发钱包操作。

## 本机配置

配置放在被 Git 忽略的 `.env` 和 `secrets/` 中。必须保留：

```env
DEFAULT_NETWORK=base-mainnet
BASE_MAINNET_RPC_URL=
BASE_MAINNET_LEDGER_ADDRESS=0x2836ce99B19a4aF3e048c8fd95B4fEe64e8A0ab3
BASE_MAINNET_LEDGER_START_BLOCK=46356326
EVM_PRIVATE_KEY_FILE=./secrets/evm_private_key.txt
JUNKMAN_ONCHAIN_STRATEGY_ID=junkman-spx-0dte-sim-v1
ONCHAIN_MAX_GAS_ETH_PER_TX=0.0005
```

`ONCHAIN_MAX_GAS_ETH_PER_TX` 是广播前的硬上限。发布器还会验证签名钱包是
合约 owner，并在交易确认回执中重新解析和核对 `RecordCommitted` 的
`recordId` 与 `dataHash`。

## 边界

链上哈希可以证明某份记录不晚于某个区块已经存在且之后未被静默修改，
但它不自动证明策略盈利、真实可成交性、监管合规或未来业绩。对外展示时应
明确标注目前记录来自 Moomoo 模拟盘且收益未计手续费。
