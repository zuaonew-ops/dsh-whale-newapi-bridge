# SPEC — dsh-whale-newapi-bridge（开发期冻结接口契约存档）

> **公开版说明**：本文件是开发期的接口契约存档，保留了当时的并行实现分工措辞——
> `lead` / `protocol` / `core` / `bridge` / `verify` 是模块角色名（作者 / 协议 / 核心 / 桥接 / 验证），
> 不对应任何对外团队。安装、配置与使用请看 [README.md](README.md) 与 [docs/INSTALL.md](docs/INSTALL.md)；
> 当前行为以 `lib/` 实现与 `test/` 验证为准。

> 本文件是开发期的**唯一接口契约来源**。任何模块不得单方面修改本文件；需要变更时向作者提出，
> 由作者更新并广播版本号。实现必须与本文件的签名/形状逐字一致。

版本：`spec-v2`（2026-10-05；v1 → v2 的修订见文末 §10，**§10 优先级高于前文**）

---

## 0. 目标

写一个 **DSH 扩展插件**（bundle，宿主半区 host-only），把小鲸鱼挂件的余额来源接到
New API 中转站 `https://relay.example.com`，使挂件里出现
「余额·团队中转站」与「今日已用」并能自动记账。

**不修改 `dsh-whale-widget` 的任何文件**（它是 npm 安装的第三方包，且会被升级覆盖）。
接入只使用它**已文档化的扩展面**：

1. `$DSH_HOME/.dshw-api.json`（`{ version:1, models:[…], usage:{} }`）—— 追加/维护一个我们的模型条目；
2. 小鲸鱼宿主会按该条目里的 `balance.url` 去取余额（`fetchModelBalance`，宿主机侧），
   所以我们的插件必须**同时提供该 URL**（本机回环路由）。

## 1. 已核实的运行时事实（不要再重复调研）

* 小鲸鱼：`dsh-whale-widget@0.3.18`，`%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-whale-widget`。
  * 插件入口 `lib/index.js`：`export default { name, apply(root) }`，内部
    `root.inject(['webServer','credentials','connection'], (ctx) => { … })`。
  * 路由：`ctx.webServer.register({ kind:'exact', path, handler(req,res) })`，注册返回 disposer，用 `ctx.effect(() => …)` 托管。
  * 凭据：`ctx.credentials.resolve(ref)` / `.set(ref, value)`（`ref` 只允许字母/数字/下划线）。
  * 取余额：`mergeNonEmpty(模板.balance, 模型.balance)` → `url = b.url.replace('{base}', model.baseUrl)` →
    带 `Authorization: b.auth.replace('{key}', 凭据值)`（GET，或 `b.method`+`b.body`）→
    按 `b.json.remaining` / `.total` / `.used`（支持 `a.b[0].c`，可选 `scale` 乘数）取值；
    `remaining===null && total!==null` 时 `remaining = total - used`；仍为 `null` → 报 `SHAPE` 错误。
  * **凭据目的地白名单**（v761 起）：只有当目标 origin 恰等于该厂商模板里写死的端点，或模型条目
    `allowCustomHost === true` 时才会把凭据发出去。我们的模型条目**必须**写 `allowCustomHost: true`。
  * 有余额接口但无凭据 → `entry.error = '未配置 <keyRef>'`，所以 `keyRef` 指向的凭据**必须存在**。
  * 每个自定义模型自动获得「余额·<模型名>」「额度·<模型名>」两个泡泡模块（无需我们写 `.dshw-bubble.json`）。
* New API 中转站（`v1.0.0-rc.40`，`system_name = New API`，`/api/status` 公开）：
  * `quota_per_unit = 500000`、`usd_exchange_rate = 7.3`、`price = 7.3`、`display_in_currency = true`、
    `quota_display_type = CUSTOM`、`custom_currency_symbol = credits`、`custom_currency_exchange_rate = 1`。
  * `GET {base}/api/status` → `{data:{…}}`（公开，无需凭据）。
  * `GET {base}/api/user/self`：**需要用户系统访问令牌**（`Authorization: Bearer <access_token>`，
    部分版本还需 `New-Api-User: <userId>`）；用 sk- 渠道 key 请求 = 401（已实测）。
    成功时 `{data:{quota, used_quota, remain_quota?, unlimited_quota, group, …}}`。
  * `GET {base}/v1/dashboard/billing/subscription`：Bearer sk- key 可用；实测
    `{hard_limit_usd:100000000, soft_limit_usd:…, system_hard_limit_usd:…}`（1e8 = 无限/哨兵）。
  * `GET {base}/v1/dashboard/billing/usage?start_date&end_date`：Bearer sk- key 可用；实测
    `{object:'list', total_usage:1834.5636}`（美分；= $18.3456）。
  * `GET {base}/v1/models`：Bearer sk- key 可用 → `deepseek-v4.1-flash, tier-max, tier-power, tier-std`。

## 2. 交付物与写入范围（互不重叠）

工作区：`<repo>\`

| 成员 | 写入范围（**只动这些**） |
|---|---|
| lead | `SPEC.md`、`README.md`、`docs/INSTALL.md`、profile 安装与最终验收 |
| protocol | `docs/PROTOCOL.md`、`test/fixtures/**`、`test/probe-relay.mjs` |
| core | `package.json`、`cordis.patch.yml`、`lib/index.js`、`lib/newapi.mjs`、`lib/config.mjs` |
| bridge | `lib/whale-registry.mjs`、`lib/whale-contract.mjs`、`docs/WHALE-CONTRACT.md` |
| verify | `test/verify-*.mjs`、`test/live-e2e.mjs`、`docs/VERIFICATION.md` |

> `test/probe-relay.mjs` 属 protocol；verify 只**运行**它，不改它。

## 3. 插件包形状（core 负责）

`package.json`（要点）：

```json
{
  "name": "dsh-whale-newapi-bridge",
  "version": "0.1.0",
  "description": "把 New API 中转站余额接入 DSH 小鲸鱼挂件（自动维护 .dshw-api.json 模型条目 + 本机余额桥）",
  "type": "module",
  "main": "lib/index.js",
  "exports": { ".": "./lib/index.js", "./package.json": "./package.json" },
  "files": ["lib", "cordis.patch.yml", "README.md"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "engines": { "node": ">=18", "dsh": ">=0.2.0-rc.1" },
  "peerDependenciesMeta": { "@deepseek-ai/schemastery": { "optional": true } },
  "license": "MIT"
}
```

`cordis.patch.yml`（要点，注意 patch 会**整行替换** `config`，所以只 insert 我们自己的一行）：

```yaml
- insert:
    - id: whale-newapi-bridge
      name: 'dsh-whale-newapi-bridge'
      # config 留给最终安装时由作者写入（profile cordis.patch.yml 覆写）
```

`lib/index.js` 导出（**必须**是这个形状）：

```js
export const name = 'dsh-whale-newapi-bridge'
export const inject = ['webServer']            // 硬依赖；credentials 用 ctx.get('credentials') 软取
export const Config = /* @deepseek-ai/schemastery z.object({...}) */
export function apply(ctx, config) { … }
```

* `Config` 优先用 `import z from '@deepseek-ai/schemastery'`（与 `dsh-better-sidebar` / `dsh-plugin-wallpaper-engine` 同款，
  该包在本机 profile 的 `node_modules/@deepseek-ai/schemastery` 中可解析）。
  若在安装后解析失败，则**降级**为不导出 `Config`、直接把 `apply(ctx, config)` 的第二个参数当普通对象用
  （并在 `docs/INSTALL.md` 里由 lead 记录实际生效的一条）。二选一必须由 core 用真实 `node` 解析验证后写进交付说明。
* `apply` 必须**永不抛出**：任何异常都吞掉并记录到内部状态（`/status` 可见），
  否则会让宿主 fiber 失败、影响用户整个 Web 界面。
* 路由用 `ctx.effect(() => ctx.webServer.register({...}))` 托管；路径冲突会 throw（路径前缀是我们独有的）。

## 4. 配置项（Config，core 负责；最终安装值由作者写）

| 键 | 类型 | 默认 | 语义 |
|---|---|---|---|
| `baseUrl` | string | `'http://127.0.0.1:3000'` | 中转站根地址 |
| `credentialRef` | string | `'NEWAPI_RELAY_TOKEN'` | 首选凭据名 |
| `credentialCandidates` | string[] | `['NEWAPI_RELAY_TOKEN','NEWAPI_API_KEY','PI_API_KEY']` | `credentialRef` 解析不到时按序尝试 |
| `authMode` | `'auto'\|'native'\|'compat'` | `'auto'` | native=访问令牌查 `/api/user/self`；compat=sk- key 查 billing 接口 |
| `userId` | string | `''` | native 模式下 `New-Api-User` 头（空=不带） |
| `modelId` | string | `'newapi_relay'` | 写进 `.dshw-api.json` 的条目 id（只允许 `[A-Za-z0-9_-]`） |
| `modelName` | string | `'团队中转站'` | 挂件里显示的名字 |
| `currency` | string | `'CNY'` | 下发币种 |
| `usdToCny` | number | `0` | 0 = 从 `/api/status` 推导（`usd_exchange_rate`） |
| `quotaPerUnit` | number | `0` | 0 = 从 `/api/status` 推导（`quota_per_unit`） |
| `fallbackTotal` | number | `0` | 0 = 无。>0 时：账户为无限额度也给出 `remaining = fallbackTotal - used` |
| `bridgeBaseUrl` | string | `''` | 空 = 自动探测（见 §6） |
| `autoSync` | boolean | `true` | 启动/周期同步 `.dshw-api.json` |
| `syncIntervalSeconds` | number | `300` | 周期同步间隔 |
| `requestTimeoutMs` | number | `15000` | 上游超时 |
| `enabled` | boolean | `true` | 总开关（false 时删除自己写的条目并注销路由语义） |

## 5. 模块接口（冻结）

### 5.1 `lib/newapi.mjs`（core）

```js
export const DEFAULT_BASE_URL = 'https://relay.example.com'
export const UNLIMITED_SENTINEL = 100000000

export function normalizeBaseUrl(raw)                      // → string（去尾斜杠；非法 → 抛 Error）
export function parseRelayStatus(json)                     // → { ok, version, systemName, quotaPerUnit,
                                                           //     usdExchangeRate, displayInCurrency,
                                                           //     quotaDisplayType, customCurrencySymbol,
                                                           //     customCurrencyExchangeRate } | { ok:false, error }
export async function fetchRelayStatus(baseUrl, deps)      // deps: { fetchImpl?, timeoutMs? }
                                                           // → { ok:true, status } | { ok:false, code, error, httpStatus? }
export async function fetchNativeUser(baseUrl, opts)       // opts: { token, userId?, fetchImpl?, timeoutMs? }
                                                           // 先带 New-Api-User（userId 非空），401/无 userId 时再试不带
                                                           // → { ok:true, httpStatus, user, withUserHeader } | { ok:false, code, error, httpStatus? }
export async function fetchCompat(baseUrl, opts)           // opts: { apiKey, fetchImpl?, timeoutMs? }
                                                           // GET subscription + usage（usage 失败不致命）
                                                           // → { ok:true, hardLimitUsd, usedCents, usedUsd } | { ok:false, code, error, httpStatus? }
export function normalizeBalance(input)                    // 纯函数，input:
                                                           // { mode:'native'|'compat', native?, compat?, status?, config }
                                                           // → 见 §5.1.1
```

`code` 取值（固定）：`'NO_CREDENTIAL'` `'HTTP_401'` `'HTTP_403'` `'HTTP_404'` `'HTTP_ERROR'`
`'TIMEOUT'` `'NETWORK'` `'NON_JSON'` `'SHAPE'` `'UNLIMITED'`。

#### 5.1.1 `normalizeBalance` 返回（**唯一余额形状**，其它模块与路由都消费它）

```js
{
  ok: true,
  source: 'native' | 'compat',          // 实际取数来源
  unlimited: boolean,                    // native: user.unlimited_quota===true；compat: hardLimitUsd>=UNLIMITED_SENTINEL
  remaining: number | null,              // 与面板一致的口径；unlimited 且无 fallbackTotal 时为 null
  total: number | null,
  used: number | null,                   // 与 remaining 同币种同口径
  currency: 'CNY' | 'USD',
  credits: number | null,                // 原始 quota 单位（native）
  usedUsd: number | null,                // compat: total_usage/100
  fetchedAt: number,                     // Date.now()
  mode: 'money' | 'credits',
  detail: { quotaPerUnit, usdExchangeRate, usedPct?, group?, note? },
  raw: { /* 已脱敏的原始字段小集合 */ }
}
// 失败：{ ok:false, code, error, httpStatus? }
```

口径规则（protocol 的 `docs/PROTOCOL.md` 必须给出依据并复核）：
1. `native`：`credits = user.quota`（或 `remain_quota` 存在时优先用它），
   `money = credits / quotaPerUnit`（USD）→ `currency==='CNY'` 时再 `× usdToCny`。
   `used = user.used_quota / quotaPerUnit × (CNY? usdToCny:1)`；`total = remaining + used`。
2. `compat`：`total = hardLimitUsd`（USD→CNY 同上），`used = usedCents/100`（USD→CNY 同上）。
   `remaining = total - used`；若 `hardLimitUsd >= UNLIMITED_SENTINEL` → `unlimited:true`，
   `remaining`：`fallbackTotal>0 ? fallbackTotal - used : null`，`total: fallbackTotal>0 ? fallbackTotal : null`。
3. `detail.note` 用中文写清「数据来源/是否无限额度/口径」，会显示在 `/status` 里。

### 5.2 `lib/whale-contract.mjs`（bridge）

```js
export const WHALE_API_FILE = '.dshw-api.json'
export function buildWhaleEntry(cfg, ctxInfo)   // → { entry, mode:'balance'|'events', warnings:string[] }
export function describeEntry(entry)           // → string（给人看的摘要，不含密钥）
```

* `ctxInfo = { bridgeUrl, credentialRef, modelId, modelName, currency, matchIds, relayBaseUrl }`。
* `mode:'balance'`（我们有可用的数值余额）时 entry =

```json
{
  "id": "<modelId>",
  "name": "<modelName>",
  "provider": "custom",
  "currency": "<currency>",
  "keyRef": "<credentialRef>",
  "baseUrl": "<relayBaseUrl>",
  "balance": {
    "url": "<bridgeUrl>/dsh-whale-newapi/balance",
    "auth": "Bearer {key}",
    "json": { "remaining": "remaining" }
  },
  "matchIds": ["deepseek-v4.1-flash", "tier-max", "tier-power", "tier-std"],
  "allowCustomHost": true
}
```

* `mode:'events'`（unlimited 且 `fallbackTotal<=0`，无法给出真实余额）时 entry =
  同上但 **不带 `balance.url`**（`balance: {"url":"","auth":"","json":{"remaining":""}}` 或省略），
  小鲸鱼据此显示「余额 —」并把今日已用按本机会话事件估算（`balanceMode='events'`）。
  此时 `warnings` 必须写明原因。

### 5.3 `lib/whale-registry.mjs`（bridge）

```js
export function resolveWhaleApiFile(dshHome)                 // → 首选 $DSH_HOME/.dshw-api.json
export function readWhaleRegistry(file)                      // → { ok, existed, registry, raw, error }
                                                             //   文件不存在 → { ok:true, existed:false, registry:{version:1,models:[],usage:{}} }
                                                             //   JSON 坏/结构不对 → { ok:false, ... }（**绝不覆盖**）
export function upsertWhaleEntry(registry, entry)            // → { registry, changed, previousEntry }
export function removeWhaleEntry(registry, id)               // → { registry, changed }
export function writeWhaleRegistryAtomic(file, registry)     // → { ok, backupPath, error }
                                                             //   写临时文件 + rename；首次修改前把原文件备份成
                                                             //   `<file>.bak-newapi-bridge`（已存在则不覆盖）
export function summarizeRegistry(registry)                  // → { modelIds:string[], usageKeys:number }
```

**硬性要求**：只增删我们自己的 `id` 条目；**必须保留** `usage`（可能很大）与其它模型条目的所有字段；
写入是原子的；解析失败时不写并返回错误；`changed===false` 时不写（避免 mtime 抖动）。

## 6. 路由契约（core；路径前缀 `/dsh-whale-newapi`）

所有路由必须先过**回环信任栅栏**（照抄 `dsh-better-sidebar/src/trust-fence.ts` 的语义：
`Host` 必须是 loopback 或 `DSHW_TRUSTED_HOSTS` 声明的权威；`Sec-Fetch-Site: cross-site` 拒绝；
带 `Origin` 时必须与本机 hostname 同源）。非法 → `403`。

1. `GET /dsh-whale-newapi/balance` —— **小鲸鱼消费**。
   鉴权：`Authorization: Bearer <凭据值>`（也接受 `?token=`）必须与插件解析到的凭据**逐字节相等**
   （恒定时间比较）；不等 → `401`。
   响应：`{ ok, remaining, currency, total, used, unlimited, source, fetchedAt, label, note }`，
   `remaining` 在 mode `balance` 下**必须是有限数值**（小鲸鱼对 `null` 会报 SHAPE 错误）；
   unlimited 且无 fallbackTotal 时该路由返回 `{ ok:false, code:'UNLIMITED', error:'无限额度…' }`，
   同时插件应把条目切成 `events` 模式（见 §5.2）。
   上游异常 → `{ ok:false, code, error }`（HTTP 200，由小鲸鱼显示错误行；不得泄露凭据）。
2. `GET /dsh-whale-newapi/status` —— 诊断（不要求 Bearer，但只回环）。
   `{ ok, version, config:{…脱敏…}, credential:{ref, present, source:'config'|'candidate'}, upstream:{…},
      balance:{…normalize 结果…}, whale:{ id, mode, entry, registryFile, registryOk, lastSyncAt, lastSyncResult,
      changed, backupPath }, bridge:{ baseUrl, selfCheck:{ ok, httpStatus, error, at } }, warnings:[…] }`
3. `POST /dsh-whale-newapi/sync` —— 强制重新探测 + 重写条目。body 可选
   `{ bridgeBaseUrl?, credentialRef?, modelId?, fallbackTotal? }`（仅回环 + 只接受这些键）。
   → `{ ok, changed, mode, entry, syncAt, balance:{…}, warnings }`。
4. `GET /dsh-whale-newapi/health` —— `{ ok:true, name, version, enabled }`（**无鉴权**，只用于本机自检）。

**桥地址自动探测顺序**：`config.bridgeBaseUrl` → `process.env.DSH_WEB_URL` →
`process.env.DSH_WEB_PORT`/`PORT` → `process.argv` 里的 `--port=<n>` → 默认 `http://127.0.0.1:19387`。
取到后拼 `<base>/dsh-whale-newapi/balance`；启动与每次 sync 后对 `<base>/dsh-whale-newapi/health`
做一次自检并把结果放进 `/status`（探测不到真实端口时**必须显式报告**，不许假装成功）。

## 7. 安全硬要求

1. 任何响应、错误消息、日志、`/status` 中都**不得**出现凭据明文（统一脱敏成 `sk-***`/`len=N`）。
2. `/balance` 必须校验 Bearer 与真实凭据相等；不得变成"任何本机进程都能读余额"的开放代理。
3. 只允许 `http:`/`https:` 上游；`baseUrl` 解析失败即拒绝；不接受 URL 里带 userinfo。
4. 写入 `.dshw-api.json` 前必须 `readWhaleRegistry` 成功；坏文件 → 只报错不写。
5. 插件加载/同步失败**不得**影响宿主：所有 `apply` 内部路径包 try/catch。

## 8. 验收标准（作者最终判定，verify 提供证据）

* A1 单元测试（离线，用 `test/fixtures/**`）全绿：`normalizeBalance` 全部分支、
  `parseRelayStatus`、`upsert/remove/read/write` 注册表（含"保留 usage 与其它模型""坏 JSON 不覆盖"）。
* A2 真实链路：`node test/probe-relay.mjs` 能打印本机中转站的 `/api/status`、compat 两个接口的真实响应
  （凭据来自 DSH 凭据文件，**不落盘、不进报告**）。
* A3 安全：跨站标记/伪造 Host → 403；错误 Bearer → 401；响应体无凭据。
* A4 安装：`plugin_manager install_bundle` 装进 `desktop` profile 后，宿主未崩、
  `GET /dsh-whale-newapi/health` 200、`/status` 显示 `whale.entry` 与 `registryFile` 正确。
* A5 接入：`$DSH_HOME/.dshw-api.json` 里出现我们的条目，且**其它条目与 `usage` 字段逐字节保留**
  （verify 用安装前的快照对比给出证据）。
* A6 小鲸鱼侧：条目被小鲸鱼读到时 `hasBalanceApi`/`balanceMode`/`error` 符合预期
  （能取到 `/dsh-whale/api-models.json` 就用它；取不到则用等价离线断言 + 说明为何不能取）。
* A7 回滚：`docs/INSTALL.md` 的回滚步骤可用；执行后 profile 与 `.dshw-api.json` 回到安装前状态。

## 9. 报告纪律

* 每个成员完成时向 lead 发一条消息：`task_id / 状态 / 改了哪些文件 / 执行的命令与关键输出 / 未验证项 / 风险`。
* 不允许"我大概实现了"：每个断言都要有命令 + 输出。
* 不许改别人写入范围内的文件；需要别人改时发消息给 owner 或 lead。

## 10. spec-v2 修订（作者裁定，2026-10-05，优先级高于前文）

来源：verify 独立测试的两个真实发现 + 作者复核代码后的第三个发现。全部为**收紧**，不改变已冻结的模块签名。

### 10.1 `POST /sync` 必须与 `/balance` 同鉴权（修 verify 发现 2 的一半）

`/sync` 能改写小鲸鱼条目（包括 `balance.url`），因此**必须**校验 `Authorization: Bearer <凭据值>`
（与 `/balance` 相同的恒定时间比较；也接受 `?token=`），不等 → `401`。
理由：否则本机任意进程都能把挂件的凭据目的地改到自己控制的回环服务上，从而窃取中转站凭据。
`/status` 保持免 Bearer（只读、已脱敏、仍受回环栅栏保护）；`/health` 保持免鉴权。

### 10.2 `bridgeBaseUrl` 只允许回环 origin（修 verify 发现 2 的另一半）

`config.bridgeBaseUrl` 与 `POST /sync` 的 `bridgeBaseUrl` 覆盖**都**必须是 `http:`/`https:`、
hostname 属于回环（`localhost` / `*.localhost` / `127.0.0.0/8` / `::1`）、且不带 userinfo。
不满足 → 忽略该值（回退自动探测）并在 `warnings` 里写明原因；`/sync` 这种情况下返回 `400`。
理由：条目里的 `balance.url` 决定挂件把凭据发往哪里，`allowCustomHost:true` 会放行这个目的地。

**§10.2-a（作者追加裁定，2026-10-05，修 verify 的反向用例）**：`/sync` 覆盖与 `config.bridgeBaseUrl`
是「本机任意进程都能触达」的入口，因此强制回环；而**自动探测的候选**（`DSH_WEB_URL`、
`DSH_WEB_PORT`/`PORT`、`argv --port=`）**允许非回环**：它们只能由启动宿主的那个人设置，
不在上述威胁模型内，而且宿主的 Web 端口确实可能只绑在局域网地址上（那种部署下强行改回
`127.0.0.1` 反而会让挂件取不到数）。**但必须可见**：当最终选中的探测结果是回环之外的地址时，
插件**必须**在 `warnings` 里给出一条明确的"桥地址非回环 → 条目 balance.url 指向该主机、
挂件会把凭据发往此地址"的提示（verify 对此有断言）。上文"自动探测路径本身只产出回环地址"
一句作废，以本段为准。

### 10.3 凭据新鲜度：候选回退必须能被"后来才出现的首选凭据"接管

`resolveCredential` 现在缓存已解析到的值；只要缓存非空，新加的凭据永远不会被看到。
实际情况是本机**只有候选 `PI_API_KEY`**，而用户会在之后把**系统访问令牌**写进 `NEWAPI_RELAY_TOKEN`
（用户已明确选择这种方式）。因此：

* 当缓存到的 `ref !== config.credentialRef`（即当前用的是候选回退）时，`/balance` 与每次同步
  **必须重新解析**（等价于 `force:true`）；一旦首选 `credentialRef` 可用，立即切换并在同一轮把
  条目的 `keyRef` 改写成新 ref、按新的 authMode 重算余额；
* 当缓存到的 `ref === config.credentialRef` 时**才**允许继续缓存（避免每个请求都打凭据服务）。

### 10.4 安装值（作者决定，写进 profile 配置，不改代码默认）

**2026-10-05 修订（作者，站方口径确认后）**：安装值最终采用 `currency: 'CNY'` + `usdToCny: 1`。
该站的 `quota_display_type=CUSTOM`、`custom_currency_symbol=credits`、`custom_currency_exchange_rate=1`，
且**站方明确 `credits` 就是人民币 1:1**（`usd_exchange_rate=7.3` 不参与面板显示）→
`ctx.rate = currency==='CNY' ? usdToCny : 1 = 1`（`lib/newapi.mjs:851`），
`remaining = quota / quota_per_unit` 与面板数字**同值**、标签显示 `¥`，挂件扣费与网站同币同数。
本修订**取代**原记录 `currency:'USD'` + `usdToCny: 1` —— 两者数值完全等价，仅标签 `$` vs `¥` 不同；
契约层不变（`currency ∈ {'CNY','USD'}` + `rate` 规则、以及"要与面板数字一致就别用 7.3"这条结论依旧成立）。
**不**放开 `currency` 取值域（小鲸鱼侧币种校验为 `/^[A-Z]{3}$/`，`credits` 会破坏记账）。

### 10.5 native 荒诞值护栏（作者追加，2026-10-05）

**背景**：`/api/user/self` 的 `data.quota` 在"无限额度"账户上可能是 `-1`、`0` 或一个巨大的哨兵值。
若不设护栏，`remaining` 会变成负数或天文数字：小鲸鱼会显示"负余额 / 千万亿余额"，
而且它的记账内核 `moneyUnits()` 用 `Number.isSafeInteger(value × 1e8)` 校验 —— 超过约 9×10⁷ 的金额会直接抛
「金额无效或超出可记账范围」，污染该模型的条目状态。因此 `normalizeBalance` 的 native 分支必须：

1. `credits = quota/remain_quota` 取到后，若 `credits <= 0` **或** `credits / quotaPerUnit > 1e6`
   （即 > 100 万 面板单位，远超正常中转站余额，且在记账安全范围内）→ **不产出数值余额**：
   `unlimited: true`、`remaining: null`，并按 §5.1.1 规则 2 走 `fallbackTotal`（`>0` 时
   `remaining = fallbackTotal - used`，否则 `null` → `events` 模式），`detail.note` 写明触发了护栏及原始值（脱敏、只报数量级）。
2. 有 `remain_quota` 时仍优先用它（§5.1.1 规则 1 不变），护栏对最终采用的那个值生效。
3. 该护栏**不得**影响 compat 分支（compat 只看 `hard_limit_usd >= 1e8` 哨兵）。

阈值与理由写进 `docs/PROTOCOL.md`/实现注释，便于日后按站点实际情况调整。

### 10.6 桥地址探测必须包含宿主 Web 服务的实时 origin（作者追加，2026-10-18）

**背景（真实故障，2026-10-18 实测）**：DSH 桌面宿主（Electron 外壳）用 `--port 0` 启动 profile ——
Web 端口由系统随机分配、不落盘、每次启动都不同（一次应用升级后实测 `19387` → `49844`）。而 §6 的
探测链前三项在插件 `apply`/`sync` 时**都拿不到真实端口**：`config.bridgeBaseUrl` 默认空；
`DSH_WEB_URL` 是 Web 服务 bind 之后才注入给**子进程**的，宿主自己的 `process.env` 里没有；
`process.argv` 里也没有真实 `--port=<n>`（宿主传给 profile 的是 `--port 0`，且 `0` 不是可用端口）。
于是探测一路掉到默认 `http://127.0.0.1:19387`：自检必然失败，写进 `.dshw-api.json` 的
`balance.url` 指向没人监听的端口 → 挂件取不到余额（`/status.bridge.selfCheck.ok=false`、
`warnings` 里是「桥自检未通过：… fetch failed」）。

**修订**：探测链插入一个候选 —— `ctx.webServer.getOrigin()`（Cordis `webServer` 服务的公开方法，
返回宿主**实际监听**的 origin），位置在 `DSH_WEB_URL` **之后**、`DSH_WEB_PORT`/`PORT` 之前：

`config.bridgeBaseUrl` → `process.env.DSH_WEB_URL` → **`ctx.webServer.getOrigin()`** →
`process.env.DSH_WEB_PORT`/`PORT` → `process.argv` 的 `--port=<n>` → 默认 `http://127.0.0.1:19387`。

1. 放在 `DSH_WEB_URL` **之后**，是为了不改变 §10.2-a 已裁定的行为：显式设置的 env 候选仍然优先，
   且它非回环时照旧产生「桥地址非回环」的可见提示。`getOrigin()` 是宿主自身的事实，只在没有任何
   显式来源时兜底。
2. `getOrigin()` 在 Web 服务 `listen` 之前会**抛**（`webServer` 契约明说 "before `listen` binds a
   port"）→ 插件必须捕获并跳过该候选（**不**产生 warning 噪音），退回下一候选。此时若最终落到默认
   地址，自检如实失败（§6「探测不到真实端口时必须显式报告」不变）。
3. 探测本来就在**每次同步**重做（§6.3「强制重新探测」），因此端口变化（应用重启）最多在一个
   `syncIntervalSeconds` 内被自动修正；`/sync` 也会立刻修正。
4. `getOrigin()` 的返回值按 §10.2-a 同样**允许非回环**（宿主可能只绑在局域网地址上），非回环时照旧
   产生可见提示。
5. 独立验证：`node test/verify-live-origin.mjs`（6/6）—— 实时 origin 被采用且条目 `balance.url` 跟着走、
   端口变化后一次 `/sync` 改写条目、`DSH_WEB_URL` 仍优先、缺失/抛异常时退回默认、`config.bridgeBaseUrl`
   仍最优先、真实注册表只读守卫。

