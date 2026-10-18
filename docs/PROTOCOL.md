# PROTOCOL — New API 余额/用量协议规格（带证据）

> **公开版说明**：开发期交付文档存档；文中 `protocol` / `core` / `bridge` / `verify` / `lead`
> 是当时的模块角色名（协议 / 核心 / 桥接 / 验证 / 作者），不对应任何对外团队。
> 安装与使用请看 [../README.md](../README.md)、[INSTALL.md](INSTALL.md)。

> 本文件由 `protocol` 编写，属于 `dsh-whale-newapi-bridge` 的**协议侧交付**，是 SPEC 的
> 事实依据层：SPEC 定义接口形状，本文件说明**每个数值到底是什么、怎么算才和面板一致**。
> 本文件**不修改** SPEC；与 SPEC 不一致的地方集中在 §7，交由作者决定。

* 目标站点：`https://relay.example.com`（`system_name = New API`，`version = v1.0.0-rc.40`）
* 上游仓库：<https://github.com/QuantumNous/new-api>，**tag `v1.0.0-rc.40`**
  = commit `0aec08fee811ec6136828fda790551b49e410301`（2026-09-21T23:02:57+08:00），
  本地 checkout `%TEMP%\newapi-rc40`（`git status` 干净；关键文件 blob SHA 已与 GitHub contents API 对齐）。
  本文所有 `path:line` 均指**该 tag**，URL 一律钉在 tag 上以免漂移。
* 官方文档：<https://docs.newapi.pro>（`docs_link` 字段指向它）
* 生成/复核工具：`test/probe-relay.mjs`（本目录的 `test/fixtures/**` 由它导出）

## 0. 证据分级

全文每条结论都带下列标记之一，**请不要把推断当实测用**：

| 标记 | 含义 |
|---|---|
| 【实测】 | 本机对 `relay.example.com` 实际发请求得到的响应/状态码（命令见附录 B） |
| 【源码】 | 上游 tag `v1.0.0-rc.40` 源码，给出 `path:line` + 可点击 URL |
| 【文档】 | 官方文档或仓库内文档（`docs/*.md`、OpenAPI）原文 |
| 【推断】 | 由【实测】+【源码】推出的结论，会写明推理链与替代解释 |
| 【未定】 | 本机与源码都无法确定，明确标注 |

---

## 1. 站点基本事实（实测）

```
$ node test/probe-relay.mjs
[OK  ] api/status                          GET /api/status → HTTP 200 (82ms, 2985B)
       X-New-Api-Version: v1.0.0-rc.40
       version = v1.0.0-rc.40
       system_name = New API
       price = 7.3
       quota_per_unit = 500000
       usd_exchange_rate = 7.3
       display_in_currency = true
       quota_display_type = CUSTOM
       custom_currency_symbol = credits
       custom_currency_exchange_rate = 1
       server_address = https://relay.example.com
       start_time = 1790876400
```

【实测】`GET /api/status` 无需任何凭据、HTTP 200，响应体形如 `{"data":{…},"message":"","success":true}`
（字段都在 `data` 里；完整样本见 `test/fixtures/status.json`）。
【源码】该路由**没有任何鉴权中间件**：`router/api-router.go:26` `apiRouter.GET("/status", controller.GetStatus)`，`/api` 分组只挂了 `RouteTag/gzip/AccessTokenAudit/BodyStorageCleanup/GlobalAPIRateLimit`（`router/api-router.go:16-26`）——<https://github.com/QuantumNous/new-api/blob/v1.0.0-rc.40/router/api-router.go#L16-L26>。

本机凭据：`%USERPROFILE%\.dsh\.credentials.yaml` → `refs.PI_API_KEY`（**sk- 渠道 key，长度 51**；本文件与脚本输出中一律脱敏为 `sk-***len=51`）。

---

## 2. `GET /api/status` 各字段语义，以及「面板上的余额」到底怎么算

### 2.1 字段逐个说清

| 字段 | 本机实测值 | 语义 | 证据 |
|---|---|---|---|
| `version` | `v1.0.0-rc.40` | 站点版本 | 【源码】`controller/misc.go:54` |
| `quota_per_unit` | `500000` | **1 USD = 500000 quota 单位**，即「quota → USD」的**唯一除数** | 【源码】`common/constants.go:22` `var QuotaPerUnit = 500 * 1000.0 // $0.002 / 1K tokens`；`controller/misc.go:77` 把它作为 `quota_per_unit` 下发；可在后台被 DB option `QuotaPerUnit` 覆盖（`model/option.go:166`、`:659-660`） |
| `usd_exchange_rate` | `7.3` | **仅**用于 `quota_display_type = CNY` 时的换算（1 USD = 7.3 CNY）；`USD`/`CUSTOM`/`TOKENS` 下**完全不参与计算** | 【源码】`setting/operation_setting/payment_setting_old.go:18` `var USDExchangeRate = 7.3`；消费点只有 CNY 分支 `controller/billing.go:50,96` 与 `web/src/lib/currency.ts:189-195` |
| `price` | `7.3` | **充值单价**（购买 1 USD 额度需付多少本地货币），**不是**余额换算率 | 【源码】`setting/operation_setting/payment_setting_old.go:16` `var Price = 7.3`；语义见 `web/src/lib/currency.ts:34-35`（"Recharge Price (priceRatio): Cost in local currency to purchase 1 system USD"） |
| `display_in_currency` | `true` | **兼容旧前端的布尔**：`quota_display_type != "TOKENS"` 时为 true，即「以货币形式展示而非 token 数」。真正的口径由 `quota_display_type` 决定 | 【源码】`controller/misc.go:78-79`；`setting/operation_setting/general_setting.go:44-47` `IsCurrencyDisplay() { return generalSetting.QuotaDisplayType != QuotaDisplayTypeTokens }` |
| `quota_display_type` | `CUSTOM` | **口径主开关**：`USD` / `CNY` / `TOKENS` / `CUSTOM` | 【源码】常量 `general_setting.go:6-11`，getter `:54-57` |
| `custom_currency_symbol` | `credits` | `CUSTOM` 口径下的展示符号 | 【源码】`general_setting.go:19-20,60-74` |
| `custom_currency_exchange_rate` | `1` | `CUSTOM` 口径下 **1 USD = X 自定义货币**，本机 X=1 | 【源码】`general_setting.go:21-22`（注释「自定义货币与美元汇率（1 USD = X Custom）」）、`:76-90` `GetUsdToCurrencyRate()`：`USD→1`，`CNY→usdToCny`，`CUSTOM→CustomCurrencyExchangeRate`（>0 时），否则 1 |

**一句话口径**：本机是 `CUSTOM` + 符号 `credits` + 汇率 `1`，所以**面板把「USD 数值」1:1 当成 credits 显示**；
`usd_exchange_rate = 7.3` 与 `price = 7.3` 都**不参与**余额显示（前者只在 CNY 口径用，后者是充值定价）。

### 2.2 面板余额的取数点

【源码】面板「钱包」页的 **Current Balance** 卡片：

```
web/src/features/wallet/index.tsx:116-119   const response = await getSelf()   // GET /api/user/self
web/src/features/wallet/components/wallet-stats-card.tsx:56-69
    { label: 'Current Balance', value: formatQuota(props.user?.quota ?? 0), description: 'Remaining quota' }
    { label: 'Total Usage',     value: formatQuota(props.user?.used_quota ?? 0) }
```

即余额 = `/api/user/self` 的 `data.quota`（**剩余额度**，原样整数），已用 = `data.used_quota`。
（`profile-header.tsx`、`summary-cards.tsx` 用同一对字段；rc.40 **没有** `/api/user/dashboard` 这个接口。）
URL：<https://github.com/QuantumNous/new-api/blob/v1.0.0-rc.40/web/src/features/wallet/components/wallet-stats-card.tsx#L56-L69>

### 2.3 展示层公式（把 quota 整数变成屏幕上的字符串）

【源码】调用链 `formatQuota` → `formatQuotaWithCurrency` → `formatCurrencyFromUSD` → `formatCurrencyValue`：

```js
// web/src/lib/format.ts:73-79
formatQuota(q) = formatQuotaWithCurrency(q, { digitsLarge: 2, digitsSmall: 4, abbreviate: true })

// web/src/lib/currency.ts:516-525
formatQuotaWithCurrency(q) { const amountUSD = q / config.quotaPerUnit ; return formatCurrencyFromUSD(amountUSD) }

// web/src/lib/currency.ts:187-216  —— quota_display_type 分派
USD    : { kind:'currency', symbol:'$', currencyCode:'USD', exchangeRate: 1 }
CNY    : { kind:'currency', symbol:'¥', currencyCode:'CNY', exchangeRate: usdExchangeRate }
CUSTOM : { kind:'custom',   symbol: customCurrencySymbol,       exchangeRate: customCurrencyExchangeRate }
TOKENS : { kind:'tokens',   quotaPerUnit }

// web/src/lib/currency.ts:408-439  formatCurrencyFromUSD
tokens 分支 : display = formatNumberWithSuffix(amountUSD * quotaPerUnit, 0, 4, abbreviate)   // == 原 quota 数
其它        : value = amountUSD * meta.exchangeRate   →  formatCurrencyValue(value)

// web/src/lib/currency.ts:320-353  formatCurrencyValue
digits = (|value| >= 1) ? 2 : 4 ;  minimumFractionDigits: 0
CUSTOM 分支 : `${symbol} ${Intl.NumberFormat(locale,{minimumFractionDigits:0,maximumFractionDigits:digits}).format(v)}`
USD/CNY分支 : Intl.NumberFormat(locale,{style:'currency',currency:code,currencyDisplay:'narrowSymbol',...})
```

URL：<https://github.com/QuantumNous/new-api/blob/v1.0.0-rc.40/web/src/lib/currency.ts#L187-L216> ·
<https://github.com/QuantumNous/new-api/blob/v1.0.0-rc.40/web/src/lib/currency.ts#L516-L525> ·
<https://github.com/QuantumNous/new-api/blob/v1.0.0-rc.40/web/src/lib/currency.ts#L320-L353>

**本机口径展开**（`q` = `data.quota`）：

```
usdOrCredit = q / 500000          // 唯一的除法
credits     = usdOrCredit * 1     // custom_currency_exchange_rate = 1
显示字符串  = "credits " + Intl(credits, maxFrac = (|credits|>=1 ? 2 : 4), minFrac = 0)
例：q = 25,000,000  →  credits 50
    q = 100         →  credits 0.0002
```

### 2.4 结论：与面板一致的「余额」

> **`面板余额(credits) = data.quota / quota_per_unit × custom_currency_exchange_rate`**
> 本机 = `data.quota / 500000`，单位记作 `credits`。
> 同理 **面板「已用」= `data.used_quota / 500000`**。
> 【源码】证据：`wallet-stats-card.tsx:56-69` + `currency.ts:516-525` + `currency.ts:187-216`。
> 【实测】的限制：本机只有 sk- key，`/api/user/self` 一律 401（§3.3），**这条公式无法在本机实测验证**；
> 它是**纯源码依据**。若日后拿到 PAT，可用附录 B 的命令 3 实测核对。

【源码】格式化的一个坑：`Intl.NumberFormat` 用的是**运行环境 locale**（调用点 `options.locale` 均为 `undefined`），
中文面板会有千分位差异，且 `|value| >= 1000` 时走 locale 敏感的紧凑写法（`"$28万"` vs `"$280K"`，
见 `currency.ts:98-99`）。做字符级对齐时需要固定 locale。

### 2.5 荒诞值护栏：`data.quota` 何时算「不可用余额」（spec-v2 §10.5）

**问题**：`/api/user/self` 的 `data.quota` 在**无限额度**账户上并不可信，可能是：

* `-1` / `0` —— 哨兵式占位，含义是「不限量」而不是「没余额」；
* 一个天文数字 —— 后台把额度配成极大值。

直接换算会得到**负余额**或 `credits 1.00e+12` 这类垃圾数字；更严重的是它会撞上小鲸鱼记账内核的
**定点整数校验**（见下）而抛异常，进而污染该模型的记账条目。因此 spec-v2 §10.5 要求设护栏。

**判定规则**（实现：`lib/newapi.mjs`，常量 `INSANE_CREDITS_PANEL_UNITS`）

| 步骤 | 规则 | 源码 |
|---|---|---|
| 1 | `credits` **优先取 `remain_quota`**，缺失才回退 `quota`（§5.1.1 规则 1 不变） | `lib/newapi.mjs:668` `const credits = remain !== null ? remain : quota`（`:666-667` 取两个字段） |
| 2 | `panelUnits = credits / quota_per_unit`（面板单位；`quota_per_unit <= 0` 时为 `null`） | `lib/newapi.mjs:683` |
| 3 | **荒诞值判据**：`credits <= 0` **或** `panelUnits > 1e6` | `lib/newapi.mjs:684` `sanityViolation = !(credits > 0) \|\| (panelUnits !== null && panelUnits > INSANE_CREDITS_PANEL_UNITS)` |
| 4 | 触发 → **不产出数值余额**：`unlimited: true`、`remaining: null`（配了 `fallbackTotal>0` 时 `remaining = fallbackTotal - used`），随后按 SPEC §5.2 转 `events` 模式 | `lib/newapi.mjs:688` `noNumericBalance = unlimited \|\| sanityViolation`；`:713-720` 分支；`:738` 输出 `unlimited: noNumericBalance` |
| 5 | 诊断字段（**仅在触发时出现**）`detail.sanityGuard = { credits, panelUnits, threshold }` | `lib/newapi.mjs:731-734` |

阈值常量本身：`lib/newapi.mjs:46` `const INSANE_CREDITS_PANEL_UNITS = 1e6`。
护栏作用在**最终采用的那个值**上（因为第 1 步已经把 `remain_quota` 优先选出来了）。

**`detail.sanityGuard` 的字段类型要注意**（实现细节）：

* `threshold` 是**数字** `1e6`（即 `INSANE_CREDITS_PANEL_UNITS`）；
* `credits` / `panelUnits` 经 `magnitudeOf()`（`lib/newapi.mjs:49-55`）**只报数量级**，是**字符串**：
  `|v| >= 1e6` 或 `< 1e-3` → 指数串（如 `"1.00e+12"`）、`0` → `"0"`、其余保留 3 位小数；
  `quota_per_unit <= 0` 时 `panelUnits` 为 `null`。
  → **消费方不要把 `sanityGuard.credits` 当数字做算术**（它是数量级描述，也是脱敏手段：不把天文数字整段写进 note）。
* 判据写成 `!(credits > 0)` 而非 `credits <= 0`：除 0/负数外还顺带拦住 `NaN`（`NaN <= 0` 为 `false`，用 `<=` 会漏）。

**为什么阈值是 `1e6`（面板单位）**

小鲸鱼 `dsh-whale-widget@0.3.18` 的记账内核是**定点整数**：`lib/accounting.mjs:4` `const SCALE = 100000000`（1e8），
`lib/accounting.mjs:6-11`：

```js
export function moneyUnits(value) {
  const n = Number(value)
  const units = Math.round(n * SCALE)
  if (!Number.isFinite(n) || !Number.isSafeInteger(units)) throw new Error('金额无效或超出可记账范围')
  return units
}
```

而余额观测点 `observeBalance()`（`lib/accounting.mjs:145-148`）第一件事就是
`const units = moneyUnits(snapshot.balance)` —— **喂进去的每个余额都会先过这道校验**
（`lib/index.js:9` 导入、`:2856` 调用 `observeBalance(led, {...})`）。

* **安全上限**：`Number.MAX_SAFE_INTEGER = 9007199254740991`，÷ 1e8 = **90071992.547…**，
  即**约 9.007×10⁷ 面板单位**；超过就抛「金额无效或超出可记账范围」。
* **取 1e6 的理由**：距安全上限 `9.007e7 / 1e6 ≈ 90.07 倍`（`log10 90.07 ≈ 1.96`）→ **约两个数量级余量**；
  同时 100 万面板单位（本机 = `$1,000,000` ≈ `5×10¹¹` quota）**远超任何正常中转站余额**，不会误伤真实账户。
* 两侧约束方向相反（阈值要**低**到不撞记账、又要**高**到不误伤），`1e6` 正好落在中间——这就是选它的理由。
* 旁证：同一内核 `lib/accounting.mjs:150` 还有币种校验 `/^[A-Z]{3}$/`，这正是 SPEC §10.4 不放开 `currency`
  取值域（如 `'credits'`）的原因——**小鲸鱼侧会直接抛「余额币种无效」**。

**两条不要搞混的边界**

* 护栏**只作用于 native 分支**（SPEC §10.5 第 3 条）：compat 的「无限」判定仍是
  `hard_limit_usd >= UNLIMITED_SENTINEL (1e8)`（`lib/newapi.mjs:764`），与本节阈值无关。
* 护栏**不改变** §2.4 的公式：`credits` 正常时仍按
  `data.quota / quota_per_unit × custom_currency_exchange_rate` 换算，护栏只是把「明显不可能」的值挡掉。

**与 spec-v2 §10.1/§10.2/§10.3 的关系（口径是否受影响）**

§10.1（`/sync` 同鉴权）、§10.2（`bridgeBaseUrl` 只允许回环 origin）、§10.3（凭据新鲜度）三节全部是
**路由与凭据策略**，不触碰 `data.quota` / `remain_quota` / `hard_limit_usd` / `total_usage` 的任何单位与换算口径，
也不改变 §5.1.1 的取值优先级。**因此本文件 §1~§5 的既有结论全部继续成立**；
spec-v2 中唯一影响余额口径的是 §10.5，对应的就是本节（§10.4 是把 §7 第 4 行的建议落成安装值：`currency:'USD'` + `usdToCny:1`）。

---

## 3. `GET /api/user/self`：鉴权与字段语义

### 3.1 路由与鉴权链

【源码】`router/api-router.go:91-98`：

```go
selfRoute := userRoute.Group("/")
selfRoute.Use(middleware.DisableCache(), middleware.UserAuth())
    ...
    selfRoute.GET("/self", controller.GetSelf)
```

<https://github.com/QuantumNous/new-api/blob/v1.0.0-rc.40/router/api-router.go#L91-L98>

`middleware.UserAuth()`（`middleware/auth.go:100-104`）只是 `authHelper(c, common.RoleCommonUser)`
（`:47-81`），真正的凭据判定在 `authenticateDashboardRequest` → `classifyDashboardCredential`
（`:147-187`）：

```go
// middleware/auth.go:158-186（摘要）
raw, ok := authorizationToken(c.GetHeader("Authorization"))      // 只读 Authorization 头
if !ok { return ... dashboardCredentialUnmatched }               // 无头 → 401
identity, internal, err := service.ParseDashboardAccessToken(raw)
if internal { ..., user, err := service.ValidateLoginSession(identity) ... }   // 面板短期 JWT
patUser, err := model.ValidateAccessToken(raw)                    // 用户系统访问令牌(PAT)：users.access_token 精确匹配
if patUser == nil || patUser.Id <= 0 { return ... dashboardCredentialUnmatched }
```

<https://github.com/QuantumNous/new-api/blob/v1.0.0-rc.40/middleware/auth.go#L158-L201>

要点（三条都与 SPEC §1 的措辞有关）：

1. **`Authorization: Bearer <access_token>` 是唯一入口**；而且 `authorizationToken`（`:189-201`）
   同时接受 `Bearer <x>` 与**裸 `<x>`**。
2. **`New-Api-User` 头在 rc.40 完全不参与鉴权**：middleware 里没有任何一处读它
   （全仓库 `(?i)new-api-user` 只命中 i18n 文案、OpenAPI 描述与仓库文档）。仓库文档原文：
   `docs/authentication.md:146`「`User.AccessToken`（面板 PAT）继续支持 `Authorization: Bearer <pat>`，
   也兼容原有的单值 `Authorization: <pat>`。`New-Api-User` 不再参与鉴权，外部脚本不需要再发送
   Bearer 与用户 ID 双请求头」，另见 `:3`、`:176`。
   【文档】官方文档 <https://docs.newapi.pro/zh/docs/api/management/auth> 仍把
   `New-Api-User: {user_id}` 列为「必需请求头」，但措辞是「**部分接口**要求」——与源码一致的理解是：
   它只对更老版本/个别接口有意义，**`/api/user/self` 不需要**。
   → 结论：**可以不带；带上也无害**（core 的 `fetchNativeUser` 先带后不带的重试策略是安全的向前/向后兼容）。
3. **不会回退到 sk- 渠道 key 鉴权**：`UserAuth` 链上没有 `TokenAuth`；把 sk- key 当 Bearer 发过去
   只是「未知的不透明令牌」→ `model.ValidateAccessToken` 查 `users.access_token` 落空 → 401。
   （只有 `TokenOrUserAuth()`（`:257-282`）才会回退到 `TokenAuth()`，而该路由没挂它。）

### 3.2 失败形态（实测 + 源码）

【实测】无 `Authorization`、坏令牌、真实 sk- key 三种情况**都是 401**，
响应头带 `X-New-Api-Version: v1.0.0-rc.40`，响应体（91 字节 JSON，`test/fixtures/user-self-unauthorized.json`）：

```json
{"code":"AUTH_UNAUTHORIZED","message":"Unauthorized, invalid access token","success":false}
```

【源码】文案是 i18n 的，随 `Accept-Language` 变化：无该头时英文（`i18n/locales/en.yaml:31`
`auth.access_token_invalid: "Unauthorized, invalid access token"`），zh-CN 为
「无权进行此操作，access token 无效」（`i18n/locales/zh-CN.yaml:32`）。产生点 `middleware/auth.go:227-229`。
同一函数还会给出：`AUTH_TOKEN_EXPIRED`（过期面板 JWT，文案「无权进行此操作，未登录且未提供 access token」）、
`AUTH_SESSION_REVOKED`、`AUTH_USER_DISABLED`（`auth.go:56-59`）、403 `AUTH_INSUFFICIENT_PRIVILEGE`（`:60-63`）。
→ 因此**不要按 message 文案判断错误**，要按 `code` 或 HTTP 状态。

### 3.3 本机为什么用不了这个接口

本机只有 `refs.PI_API_KEY`（sk- 渠道 key）。`/api/user/self` 要的是
**用户系统访问令牌**（面板「个人设置 → 安全设置 → 系统访问令牌」生成，上游 `GET/POST/DELETE /api/user/token`，
`router/api-router.go:102-105`，生成实现 `controller/access_token.go:24-49`，存 `users.access_token`，
`model/user.go:95`，校验为**整串精确匹配** `model/user.go:1228-1242`）。
→ **native 模式在本机不可用**（除非用户去面板生成一个 PAT 并写进 DSH 凭据）。
这正是 `test/probe-relay.mjs` 的 C7/C8/C9 三条检查在断言的事。

### 3.4 成功响应的字段与语义

【源码】`controller/user.go:464-486`（`GetSelf`）→ `buildSelfUserData(user)`（`:491-523`）：

```
envelope: { "success": true, "message": "", "data": { ... } }
data 键（逐字）:
  id, username, display_name, has_password, role, status, email,
  github_id, discord_id, oidc_id, wechat_id, telegram_id, group,
  quota, used_quota, request_count, aff_code, aff_count, aff_quota,
  aff_history_quota, inviter_id, linux_do_id, setting, stripe_customer,
  sidebar_modules, permissions
```

URL：<https://github.com/QuantumNous/new-api/blob/v1.0.0-rc.40/controller/user.go#L491-L523>

| 字段 | 存在？ | 单位与含义 | 证据 |
|---|---|---|---|
| `quota` | ✅ | **剩余额度**，整数，单位 = quota（÷`quota_per_unit` 得 USD）。证明它不含已用：`controller/billing.go:25` 把 `quota` 读进 `remainQuota`，`:41` 再算 `quota := remainQuota + usedQuota`（总额 = 剩余 + 已用） | 【源码】`user.go:509`；`billing.go:25,41`；`model/user.go:1245-1255` `GetUserQuota` 取的是 `quota` 列 |
| `used_quota` | ✅ | **累计已用**，同 quota 单位（`model/user.go:98`）。只做 `used_quota + ?` 累加，没有窗口/重置 | 【源码】`user.go:510`；`model/user.go:1442-1447` `UpdateUserUsedQuota` |
| `remain_quota` | ❌ **不存在** | 该字段只属于令牌（`model.Token.RemainQuota`，`model/token.go:23`），User 模型与 `GetSelf` DTO 都没有 | 【源码】`model/token.go:23-24` vs `controller/user.go:495-522` |
| `unlimited_quota` | ❌ **不存在** | 「无限额度」只是**令牌级布尔** `Token.UnlimitedQuota`（`model/token.go:24`），**User 上没有这个概念** | 同上 |
| `access_token` | ❌ 不返回 | 上游有测试断言响应不含 `password`/`access_token`/`remark`（`controller/security_account_test.go:442-444`） | 【源码】 |
| `setting` | ✅ | **原始 JSON 字符串**（DB 文本列），不是对象——客户端要自己 `JSON.parse` | 【源码】`user.go:518` |

### 3.5 令牌级「无限额度」是什么

【源码】`Token.UnlimitedQuota`（`model/token.go:24`）为 true 时：跳过「令牌额度耗尽」判定
（`model/token.go:241` `if !token.UnlimitedQuota && token.RemainQuota <= 0`）与预扣检查
（`service/quota.go:144`）。而**注册时自动生成的初始令牌就是 unlimited**：
`controller/user.go:302-320` 建 `Token{ExpiredTime:-1, RemainQuota:500000, UnlimitedQuota:true}`。
→ 一台新站的默认 sk- key 很可能就是 unlimited，这直接决定 §5 的结论。
URL：<https://github.com/QuantumNous/new-api/blob/v1.0.0-rc.40/controller/user.go#L310-L320>

---

## 4. `/v1/dashboard/billing/subscription` 与 `/usage`

### 4.0 路由与鉴权（重要：与 `/api/user/self` 是两套体系）

【源码】`router/dashboard.go:10-22`：这两个接口**只**由该文件注册（同时提供带/不带 `/v1` 前缀的别名），
分组中间件是 `middleware.TokenAuth()`，**只认 sk- 渠道 key**，不认面板会话/PAT。

```go
apiRouter := router.Group("/")
apiRouter.Use(middleware.RouteTag("old_api"))
apiRouter.Use(gzip.Gzip(gzip.DefaultCompression))   // ← 响应可能被 gzip
apiRouter.Use(middleware.GlobalAPIRateLimit())
apiRouter.Use(middleware.CORS())
apiRouter.Use(middleware.TokenAuth())
    apiRouter.GET("/dashboard/billing/subscription",     controller.GetSubscription)
    apiRouter.GET("/v1/dashboard/billing/subscription",  controller.GetSubscription)
    apiRouter.GET("/dashboard/billing/usage",            controller.GetUsage)
    apiRouter.GET("/v1/dashboard/billing/usage",         controller.GetUsage)
```

<https://github.com/QuantumNous/new-api/blob/v1.0.0-rc.40/router/dashboard.go#L10-L22>

### 4.1 `subscription`：三个限额字段同值，`100000000` 是**令牌级无限额度哨兵**

【源码】`controller/billing.go:11-68`（`GetSubscription`）：

```go
if common.DisplayTokenStatEnabled {
    tokenId := c.GetInt("token_id")
    token, err = model.GetTokenById(tokenId)
    expiredTime = token.ExpiredTime
    remainQuota = token.RemainQuota
    usedQuota   = token.UsedQuota
} else {
    userId := c.GetInt("id")
    remainQuota, err = model.GetUserQuota(userId, false)
    usedQuota, err   = model.GetUserUsedQuota(userId)
}
...
quota := remainQuota + usedQuota               // ← 总额 = 剩余 + 已用
amount := float64(quota)
switch operation_setting.GetQuotaDisplayType() {
case operation_setting.QuotaDisplayTypeCNY:    amount = amount / common.QuotaPerUnit * operation_setting.USDExchangeRate
case operation_setting.QuotaDisplayTypeTokens: // amount 保持 tokens 数值
default:                                       amount = amount / common.QuotaPerUnit
}
if token != nil && token.UnlimitedQuota {      // ← 唯一能产出精确 1e8 的路径
    amount = 100000000
}
subscription := OpenAISubscriptionResponse{
    Object: "billing_subscription", HasPaymentMethod: true,
    SoftLimitUSD: amount, HardLimitUSD: amount, SystemHardLimitUSD: amount,
    AccessUntil: expiredTime,
}
```

<https://github.com/QuantumNous/new-api/blob/v1.0.0-rc.40/controller/billing.go#L11-L68>

结论（全部【源码】）：

1. `soft_limit_usd == hard_limit_usd == system_hard_limit_usd` **永远相等**（同一个 `amount`）。
   → SPEC 里「取第一个有限值」的优先级实现是安全的，但没有实质区别。字段定义见
   `controller/channel-billing.go:32-39`（<https://github.com/QuantumNous/new-api/blob/v1.0.0-rc.40/controller/channel-billing.go#L32-L39>）。
2. **`hard_limit_usd = 100000000` 是「无限额度哨兵」**，但注意它的主语是**令牌**：
   只有 `token != nil && token.UnlimitedQuota` 时才写入这个**字面量**（`:56-58`）。
   它**不是**用户余额哨兵；对普通用户（`DisplayTokenStatEnabled=false` 分支）`hard_limit_usd` 就是
   真实的 `(quota+used_quota)/QuotaPerUnit`，此时 1e8 意味着「1 亿美元额度」而不是「无限」。
3. 单位**不一定是美元**：字段名带 `_USD`，但代码按站点展示类型重解释（源码自带注释 `billing.go:43-47`）：
   `USD`/`CUSTOM` → 美元；`CNY` → **人民币**；`TOKENS` → 裸 token 数。
   本机 `quota_display_type=CUSTOM` → 走 `default` 分支 → **是美元（= credits 1:1）**。
4. `access_until` = `token.ExpiredTime`（`<=0` 归 0）。【实测】本机 = `0`
   （与「初始令牌 `ExpiredTime: -1` 永不过期」一致，`controller/user.go:316`）。

【实测】本机响应（`test/fixtures/billing-subscription.json`）：

```json
{"object":"billing_subscription","has_payment_method":true,
 "soft_limit_usd":100000000,"hard_limit_usd":100000000,"system_hard_limit_usd":100000000,
 "access_until":0}
```

### 4.2 `usage`：`total_usage` 单位是**美分**，而且**日期参数被忽略、数值是累计值**

【源码】`controller/billing.go:71-107`（`GetUsage`）**完全没有解析 query**（下为摘要，省略了 `err` 处理）：

```go
func GetUsage(c *gin.Context) {
    var quota int
    if common.DisplayTokenStatEnabled { token, _ = model.GetTokenById(c.GetInt("token_id")); quota = token.UsedQuota
    } else { quota, _ = model.GetUserUsedQuota(c.GetInt("id")) }
    amount := float64(quota)
    switch operation_setting.GetQuotaDisplayType() { ...同上... }
    usage := OpenAIUsageResponse{ Object: "list", TotalUsage: amount * 100 }
    c.JSON(200, usage)
}
```

单位由字段注释钉死：`controller/channel-billing.go:66`
`` TotalUsage float64 `json:"total_usage"` // unit: 0.01 dollar ``。
【源码】上游自己也这么用：`controller/channel-billing.go:576` `balance := subscription.HardLimitUSD - usage.TotalUsage/100`
（注意 `:560-566` 它虽然会传 `start_date`/`end_date`，但接收端并不使用）。

【实测】日期窗口**确实被忽略**（4 个差异极大的窗口 + 无参数，返回值逐字节相同）。
一条命令即可复现（`--check-window` 就是为这件事加的）：

```
$ node test/probe-relay.mjs --check-window
window 2026-01-01 → HTTP 200  total_usage = 1897.3351999999998
window 1970-01-01 → HTTP 200  total_usage = 1897.3351999999998
window 2099-12-31 → HTTP 200  total_usage = 1897.3351999999998
window 2026-10-04 → HTTP 200  total_usage = 1897.3351999999998
window (none)     → HTTP 200  total_usage = 1897.3351999999998
所有窗口（含无参数）返回同一个 total_usage → 上游忽略 start_date/end_date，该值是**累计已用**（不是窗口用量）。
RESULT: WINDOW IGNORED (cumulative)          # 退出码 0
```

（`total_usage` 随真实用量增长，同日更早的采样还有 1834.5636 / 1844.0 / 1850.6302 / 1874.1212。）

**因此**：
* `total_usage` = 该凭据（令牌或令牌属主用户）的**累计已用**，`USD 金额 = total_usage / 100`；
* 传什么窗口都不影响结果 → **不要在 `detail.note` 里写「近 30 天」**，要写「累计已用」；
* 想表达「今日已用」只能靠本机会话事件，这两个接口给不了。

### 4.3 compat 的余额恒等式（源码级）

因为 `subscription` 与 `usage` 用的是**同一对计数器**，非哨兵时：

```
hard_limit_usd  = (RemainQuota + UsedQuota) / QuotaPerUnit      // 总额
total_usage/100 =  UsedQuota / QuotaPerUnit                     // 已用
remaining       = hard_limit_usd - total_usage/100 = RemainQuota / QuotaPerUnit   // 剩余
```

这与 SPEC §5.1.1 规则 2 `remaining = total - used` **完全一致**，且是**精确恒等式**（不是近似），
并且上游自己的 `channel-billing.go:576` 就是这么算的。前提是**没有触发 1e8 哨兵**。

---

## 5. 结论：本机这台站到底能算出什么

### 5.1 与面板一致的余额（三种情形）

| 情形 | 可用前提 | 公式 | 本机是否可行 |
|---|---|---|---|
| **A. native** | 有**用户系统访问令牌 (PAT)** | `credits = data.quota / quota_per_unit × custom_currency_exchange_rate`（本机 = `quota/500000`）<br>`used = data.used_quota / 500000`<br>`total = (quota + used_quota)/500000` | ❌ 没有 PAT（本机只有 sk- key，实测 401） |
| **B. compat（非哨兵）** | sk- 令牌**不是** unlimited | `total = hard_limit_usd`；`used = total_usage/100`；`remaining = total - used` | ❌ 本机是 unlimited（见 5.2） |
| **C. compat（哨兵）** | sk- 令牌是 unlimited | `unlimited = true`；`used = total_usage/100` **仍然真实**；`remaining = fallbackTotal>0 ? fallbackTotal - used : null` | ✅ 本机必然落在这里 |

以上 A 是**纯源码依据**（§2.3/§2.4），B/C 的 `total/used/remaining` 关系有【源码】
`controller/billing.go:41,104` + `channel-billing.go:576` 与【实测】响应值双重支撑。

### 5.2 本机实测：sk- 令牌是 unlimited，`hard_limit_usd` 是哨兵

【推断（高置信）】推理链：

1. 【实测】用 sk- key 请求 `subscription` 得到 **精确的** `100000000`（三个限额同值）。
2. 【源码】唯一能产出精确 `100000000` 的代码路径是 `billing.go:56-58`，其条件为
   `DisplayTokenStatEnabled == true` **且** `token.UnlimitedQuota == true`。
   `DisplayTokenStatEnabled` 默认 true（`common/constants.go:25`）。
3. 【源码】注册时自动生成的初始令牌正是 `UnlimitedQuota: true`（`controller/user.go:310-320`），
   且 `access_until = 0` 与初始令牌 `ExpiredTime = -1` 一致。
4. 替代解释：令牌的 `RemainQuota + UsedQuota` 恰好等于 `1e8 × 500000 = 5×10^13` quota。
   这需要一个恰好为 $100,000,000 的整数额度，与「默认初始令牌 unlimited」相比概率极低；
   而且三个限额字段同值这件事**两种解释都成立**，所以真正的判据是 1e8 这个**精确字面量**。

→ 结论：**本机的 compat 结果必然是 SPEC §5.1.1 规则 2 的 `unlimited: true` 分支**，
`remaining = null`（未配 `fallbackTotal`），进而 SPEC §5.2 会把挂件条目切成 `mode:'events'`，
挂件显示「余额 —」。
【未定】无法 100% 排除「额度恰好为 5×10^13」的巧合（需要一个 PAT 或后台截图才能彻底确认）；
也不排除站点日后被管理员关掉 `DisplayTokenStatEnabled`（那样 compat 会变成**用户级**数字，公式 B 生效）。

### 5.3 对插件目标的直接影响（交给作者决策，protocol 不改 SPEC）

**用当前 sk- 凭据，「挂件里出现余额·团队中转站」这个目标达成不了**（只能显示「余额 —」+ 累计已用）。
可行出路：

1. **native**：用户在面板「个人设置 → 安全设置 → 系统访问令牌」生成 PAT，写入 DSH 凭据
   （如 `refs.NEWAPI_RELAY_TOKEN`）→ 配 `authMode:'native'`（或 `auto` 自动选中）→ 走情形 A，
   与面板完全一致。**推荐**，这是唯一能拿到真实余额的路。
2. **fallbackTotal**：人工填入账户总额度（折成 USD，或按 `currency` 口径），
   则 `remaining = fallbackTotal - used`，`used` 是**累计**已用。数值可靠但需要人工维护基数。

**配置层约束（无论走哪条路都要注意）**：SPEC §5.1.1 把输出 `currency` 冻结为 `'CNY' | 'USD'`，
写 `currency:'credits'` 会被实现回退成 **CNY**（= 面板数值 × 7.3，除非同时把 `usdToCny` 设为 1）。
**要与面板数值一致，请用 `currency:'USD'` + `usdToCny:1`**；要让单位标签也显示 `credits` 则需作者改 SPEC。
细节与源码行号见 §7 补充。

---

## 6. 复现与交叉验证

* `node test/probe-relay.mjs`：10/10 必需检查 PASS，退出码 0，输出全程 `sk-***len=51`。
  它同时断言了 C7/C8/C9「三种错误凭据都 401」与 C10「输出无密钥」。
* `node test/probe-relay.mjs --json`：同一份数据，供 verify 复用。
* 逐文件的真实性标注见 `test/fixtures/provenance.json`；人读说明见 `test/fixtures/README.md`。

---

## 7. 与 SPEC（spec-v1）的差异对照（**本文件不修改 SPEC**，仅列出证据供作者裁决）

| # | SPEC 位置 | SPEC 措辞 | 事实 | 建议 |
|---|---|---|---|---|
| 1 | §1 第 44 行、§5.1.1 | 成功响应 `{quota, used_quota, remain_quota?, unlimited_quota, group, …}`；`unlimited: user.unlimited_quota===true` | rc.40 的 `buildSelfUserData`（`controller/user.go:491-523`）**不返回** `remain_quota` / `unlimited_quota`；`UnlimitedQuota` 只是 `model.Token` 的字段（`model/token.go:24`） | 实现无需改（`undefined === true → false`，不崩），但**文档要写清**：native 在 rc.40 无法判定 unlimited，`unlimited` 实际只由 compat 哨兵判定。 |
| 2 | §1 第 42-43 行 | 「部分版本还需 `New-Api-User: <userId>`」 | rc.40 **不需要**（`middleware/auth.go:158-201` 不读该头；`docs/authentication.md:3,146,176`；OpenAPI 标注已废弃）。官方文档仍把它写成「部分接口」必需 | 保留「先带后不带」的重试（对旧版本安全），但文档改为「rc.40 不需要」。 |
| 3 | §1 第 46 行 | 「1e8 = 无限/哨兵」 | 正确，但**只对 unlimited 的令牌成立**（`billing.go:56-58`）；该字段还随展示类型变单位（CNY 时是人民币） | 采纳 `>= UNLIMITED_SENTINEL` 判定；建议 `/status` 里同时暴露 `hard_limit_usd` 与 `quota_display_type`，并对非 USD/CUSTOM 口径加 `warnings`。 |
| 4 | §4 `currency` 默认 `'CNY'`、§5.1.1 规则 1「`currency==='CNY'` 时再 `× usdToCny`」 | 默认 CNY | 本机面板口径是 **`CUSTOM`（credits × 1）**，`usd_exchange_rate=7.3` **不参与**余额显示。若插件按 CNY 输出，数值会是面板的 **7.3 倍**（交叉验证实测：CNY 下 `remaining=365`，面板口径为 `credits 50`） | 若要「与面板一致」：把 `currency`/`usdToCny` 配成 **`'USD'` / `1`**，否则用户会看到对不上的数字。**这是产品可见差异，建议作者明确选择。** |
| 5 | §5.1 `fetchCompat` 的 `usage` 窗口（未定义） | 未写 | 上游**忽略** `start_date`/`end_date`，`total_usage` 是**累计值** | 建议在 `detail.note` 写「累计已用（上游忽略日期参数）」；窗口参数随便传，但**不要**声称是「近 30 天/当月」。 |

**§7 补充：`currency:'credits'` 在当前实现下走不通（core 确认 + 源码复核）**

SPEC §5.1.1 把输出 currency 冻结为 `'CNY' | 'USD'`，因此实现层主动拒绝其它取值：

* `lib/config.mjs:265-272`：`currency` 非 `CNY`/`USD` → 记 warning 并**回退 `CNY`**；
* `lib/newapi.mjs:104-107` `normalizeCurrency()`：只有恰好 `'USD'` 才返回 `'USD'`，**其余一律 `'CNY'`**。

实操上最重要的一条推论：**用户若尝试写 `currency:'credits'`，拿到的不是 credits 口径，而是 CNY 口径（× `usdToCny`）**，
`usdToCny` 缺省时就是面板的 7.3 倍。
→ **不改 SPEC 即可让数值与面板一致**的配置是 **`currency: 'USD'` + `usdToCny: 1`**
（数值 = `quota / quota_per_unit`，与面板 `credits` 的数值相同，只是单位标签显示为 `USD`）。
若要**连单位标签也显示 `credits`**，必须由作者修改 SPEC §4/§5.1.1 放开 `currency` 取值域
（属 SPEC 变更，protocol 与 core 均不得单方面修改）。core 已把该点列为待作者决策项。

---

## 8. 仍无法确定的事项（【未定】）

1. **该账户是否 unlimited（用户级）**：本机只能证明**这枚 sk- 令牌**是 unlimited（§5.2 的推理链）。
   用户级「无限」在 rc.40 的 User 模型上根本不存在字段（`model/user.go` 无 `UnlimitedQuota`），
   所以「账户是否无限额度」这个问题在 rc.40 的语义下**没有对应字段**，只能看令牌。
2. **真实余额数值**：没有 PAT，`/api/user/self` 拿不到 → 面板余额无法本机核对（情形 A 公式未经实测）。
3. **`DisplayTokenStatEnabled` 的实际取值**：源码默认 true，但它是 DB option，`/api/status` 不下发它。
   本机是【推断】为 true（§5.2 第 2 步）。若为 false，compat 的数字会变成**用户级**，情形 B 可能生效。
4. **上游是否把 `100000000` 当作正式「无限」协议**：这是仓库里的硬编码字面量，未在
   `docs/openapi/*.json` 或官方文档中定义；`/v1/dashboard/billing/*` 两个接口在
   docs.newapi.pro 上**没有任何文档**（仓库内 OpenAPI 也没有），只能以源码为准。
5. **官方文档对 `total_usage` 单位的表述**：只有源码注释 `// unit: 0.01 dollar`；
   且在 CNY/TOKENS 口径下同一个字段会变成 0.01 人民币 / tokens×100（源码行为确定，官方意图未定义）。

---

## 附录 A：来源清单

**上游源码（tag `v1.0.0-rc.40` = `0aec08f`）**

* `controller/billing.go` — <https://github.com/QuantumNous/new-api/blob/v1.0.0-rc.40/controller/billing.go>
  （subscription `:11-68`、usage `:71-107`）
* `controller/channel-billing.go` — <https://github.com/QuantumNous/new-api/blob/v1.0.0-rc.40/controller/channel-billing.go>
  （响应结构 `:32-39`、unit 注释 `:66`、上游自算余额 `:560-578`）
* `controller/misc.go` — <https://github.com/QuantumNous/new-api/blob/v1.0.0-rc.40/controller/misc.go>（`GetStatus` `:44-176`）
* `controller/user.go` — <https://github.com/QuantumNous/new-api/blob/v1.0.0-rc.40/controller/user.go>
  （`GetSelf` `:464-486`、`buildSelfUserData` `:491-523`、初始令牌 `:302-320`）
* `middleware/auth.go` — <https://github.com/QuantumNous/new-api/blob/v1.0.0-rc.40/middleware/auth.go>
  （`authHelper` `:47-81`、`UserAuth` `:100-104`、`classifyDashboardCredential` `:158-201`、`writeDashboardAuthError` `:218-233`）
* `router/api-router.go` / `router/dashboard.go` — <https://github.com/QuantumNous/new-api/blob/v1.0.0-rc.40/router/api-router.go> ·
  <https://github.com/QuantumNous/new-api/blob/v1.0.0-rc.40/router/dashboard.go>
* `common/constants.go` — <https://github.com/QuantumNous/new-api/blob/v1.0.0-rc.40/common/constants.go#L22-L25>
  （`QuotaPerUnit`、`DisplayTokenStatEnabled`）
* `setting/operation_setting/general_setting.go` — <https://github.com/QuantumNous/new-api/blob/v1.0.0-rc.40/setting/operation_setting/general_setting.go>
* `setting/operation_setting/payment_setting_old.go` — <https://github.com/QuantumNous/new-api/blob/v1.0.0-rc.40/setting/operation_setting/payment_setting_old.go#L16-L18>
* `model/token.go` / `model/user.go` — <https://github.com/QuantumNous/new-api/blob/v1.0.0-rc.40/model/token.go#L23-L24> ·
  <https://github.com/QuantumNous/new-api/blob/v1.0.0-rc.40/model/user.go#L1245-L1260>
* 前端渲染 — <https://github.com/QuantumNous/new-api/blob/v1.0.0-rc.40/web/src/lib/currency.ts> ·
  <https://github.com/QuantumNous/new-api/blob/v1.0.0-rc.40/web/src/lib/format.ts> ·
  <https://github.com/QuantumNous/new-api/blob/v1.0.0-rc.40/web/src/lib/status-query.ts> ·
  <https://github.com/QuantumNous/new-api/blob/v1.0.0-rc.40/web/src/features/wallet/components/wallet-stats-card.tsx>

**仓库内文档**：`docs/authentication.md`（`:3`、`:146`、`:176`）、`docs/openapi/api.json:5467-5477`、`docs/translation-glossary.md:80`

**官方文档**：<https://docs.newapi.pro/zh/docs/api/management/auth>（系统访问令牌 `Authorization: Bearer {token}`；
`New-Api-User` 被描述为「部分接口」必需）。注意：`/v1/dashboard/billing/*` 在官方文档中**未收录**。

## 附录 B：复现命令

```bash
# 0) 全量探测（人读；退出码 0 = 全部必需检查通过）
node test/probe-relay.mjs

# 1) 关键字段（jq 可选）
node test/probe-relay.mjs --json

# 2) 验证 total_usage 与日期窗口无关（5 行数值必须相同；退出码 0 = 窗口被忽略）
node test/probe-relay.mjs --check-window

# 2b) 同上，机器可读
node test/probe-relay.mjs --check-window --json

# 3) 有了 PAT 之后（native 实测核对；把 <PAT> 换成面板生成的系统访问令牌）
node test/probe-relay.mjs --access-token <PAT>

# 4) 重新导出脱敏 fixture
node test/probe-relay.mjs --write-fixtures
```

**纪律**：以上命令的输出里**只允许出现** `sk-***len=N`；`probe-relay.mjs` 在写 stdout 前还有一次
「含 `sk-` 明文即中止」的兜底检查。任何情况下不要把凭据明文写进文件、提交或消息。
