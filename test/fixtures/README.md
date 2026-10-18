# test/fixtures —— 中转站真实响应的脱敏样本

本目录是 **`dsh-whale-newapi-bridge` 的离线测试输入**，供 `lib/newapi.mjs` 的纯函数
（`parseRelayStatus` / `normalizeBalance` 等）与 verify 的离线单测直接使用。

* 目标站点：`https://relay.example.com`（New API `v1.0.0-rc.40`，`system_name = New API`）
* 生成方式：`node test/probe-relay.mjs --write-fixtures`（脚本自身读 DSH 凭据文件，**不落盘密钥**）
* 生成时间与逐文件溯源：见 [`provenance.json`](./provenance.json)

## 两条硬约定

1. **fixture 文件里只有响应体本身**，没有 `_fixture` 之类的包装键——可以直接
   `JSON.parse(fs.readFileSync('test/fixtures/status.json','utf8'))` 当作真实响应喂给被测函数。
2. **所有 `sk-…` 形态的字符串都已替换成 `sk-***len=N`**；键名、嵌套结构与数值一律保持原样。
   因此可以直接断言 `data.quota_per_unit === 500000` 这类真实数值。

每个文件是**真实**还是**构造**，以 `provenance.json` 的 `real` / `constructed` 字段为准，
下表是同一信息的人读版本。

## 文件清单

| 文件 | 来源接口 | 真实性 | HTTP | 说明 |
|---|---|---|---|---|
| `status.json` | `GET /api/status` | **真实** | 200 | 公开接口，无需凭据。含 `data.version = "v1.0.0-rc.40"`、`quota_per_unit=500000`、`usd_exchange_rate=7.3`、`price=7.3`、`display_in_currency=true`、`quota_display_type="CUSTOM"`、`custom_currency_symbol="credits"`、`custom_currency_exchange_rate=1`。也含站点公开域名（`server_address` / `passkey_rp_id`）与 `chats` 模板等公开配置。 |
| `models.json` | `GET /v1/models`（Bearer sk-） | **真实** | 200 | `data[].id` = `deepseek-v4.1-flash`、`tier-max`、`tier-power`、`tier-std`；用于校验挂件条目 `matchIds`。 |
| `billing-subscription.json` | `GET /v1/dashboard/billing/subscription`（Bearer sk-） | **真实** | 200 | `hard_limit_usd = soft_limit_usd = system_hard_limit_usd = 100000000`，即**无限额度哨兵**（本机 token 是 unlimited）。`access_until = 0`。 |
| `billing-usage.json` | `GET /v1/dashboard/billing/usage?start_date&end_date`（Bearer sk-） | **真实** | 200 | `{"object":"list","total_usage":<number>}`，单位 **USD 美分**，且是**累计值**（上游忽略日期参数）。数值随真实用量变化。 |
| `user-self-unauthorized.json` | `GET /api/user/self`（不带 `Authorization`） | **真实** | 401 | `{"code":"AUTH_UNAUTHORIZED","message":"Unauthorized, invalid access token","success":false}`——错误消息随 `Accept-Language` 本地化（无该头时是英文；zh-CN 为「无权进行此操作，access token 无效」）。 |
| `user-self.json` | `GET /api/user/self`（Bearer 用户系统访问令牌） | **构造** | 200 | 见下节。字段严格照 `controller/user.go:491-523` `buildSelfUserData` 的形状；`quota`/`used_quota` 与 `billing-usage.json` 自洽。 |
| `billing-subscription-finite.json` | `GET /v1/dashboard/billing/subscription` | **构造** | 200 | 非 unlimited token 的形态（`hard_limit_usd` 有限），按 `controller/billing.go:41-66` 计算，供覆盖「`remaining = total - used`」分支。 |
| `user-self-unlimited.json` | `GET /api/user/self` | **构造** | 200 | ⚠️ 见下节——`unlimited_quota` 在 rc.40 **不存在**，此文件只为覆盖 SPEC §5.1.1 的 unlimited 分支。 |
| `error-non-json.html` | （任意返回 HTML 的上游/网关） | **构造** | 502 | 反代 502 错误页的典型形态（`text/html`），供 `NON_JSON` 分支单测使用；本机实测全部返回 JSON，没有真实样本可采。 |

## 为什么 `user-self.json` 是构造的

本机只有一枚 **sk- 渠道 key**，而 `/api/user/self` 只认**用户系统访问令牌（PAT）**：

* 实测无令牌 / 坏令牌 / 真实 sk- key 请求 → 全部 `401 AUTH_UNAUTHORIZED`（`test/probe-relay.mjs` 的 C7/C8/C9 检查）；
* 因此**本机无法取得该接口的真实成功响应**，只能按上游源码的字段形状构造。

构造依据与注意点：

1. 字段取自 `controller/user.go:491-523`（tag `v1.0.0-rc.40`）的 `buildSelfUserData`：
   `id, username, display_name, has_password, role, status, email, github_id, discord_id, oidc_id,
   wechat_id, telegram_id, group, quota, used_quota, request_count, aff_code, aff_count, aff_quota,
   aff_history_quota, inviter_id, linux_do_id, setting, stripe_customer, sidebar_modules, permissions`。
2. **该响应里没有 `remain_quota`，也没有 `unlimited_quota`，更没有 `access_token`。**
   `unlimited_quota` 只是 `model.Token` 的字段（`model/token.go:24`），User 模型上没有这个概念。
   所以 SPEC §5.1.1 里 `unlimited: user.unlimited_quota === true` 在真实响应下恒为 `false`
   （不报错，但在 rc.40 上永不触发）。详见 `docs/PROTOCOL.md` §7。
3. 数值自洽性：`used_quota = round(total_usage/100 × quota_per_unit)`，
   即 `billing-usage.json` 的累计已用换算成 quota 单位；`quota = 50 × 500000`（示例剩余 $50）。
4. `setting` 是**原始 JSON 字符串**（上游就是 `user.Setting` 文本列），不是对象。

## 未提供的 fixture

* **超时 / 连接失败**：没有响应体，无法做 fixture。请在单测里注入 `deps.fetchImpl` 抛
  `AbortError` / `TypeError('fetch failed')` 来覆盖 `TIMEOUT` / `NETWORK` 分支。
* **真实的非 JSON 响应**：网关 HTML 页无法保证可复现，因此 `error-non-json.html` 是**构造**样本
  （provenance 已标 `constructed: true`）。

## 复现

```bash
# 只跑探测、看真实 HTTP 状态（人读输出；退出码 0 = 全部必需检查通过）
node test/probe-relay.mjs

# 机器可读输出
node test/probe-relay.mjs --json

# 重新生成本目录（会覆盖现有 fixture；数值会随真实用量变化）
node test/probe-relay.mjs --write-fixtures
```

`probe-relay.mjs` 输出中只出现 `sk-***len=51`，脚本在写出前还会再做一次
「输出中含 `sk-` 明文就中止」的兜底检查。
