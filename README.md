# dsh-whale-newapi-bridge

把 [New API](https://github.com/QuantumNous/new-api)（含 One API 兼容分支）中转站的账户余额
接入 DSH（DeepSeek Harness）的**小鲸鱼挂件**（`dsh-whale-widget`）。

插件是 **host-only 的 DSH bundle**：宿主进程提供 6 条本机回环路由，并在 **DSH 设置页**新增一页
「中转站」用于配置；同时自动维护小鲸鱼挂件的模型注册表（`$DSH_HOME/.dshw-api.json`），
让挂件里出现「团队中转站」余额与「今日已用」记账。

> 本插件不修改 `dsh-whale-widget` 的任何文件（它是 npm 包，升级会被覆盖）；只使用它已文档化的扩展面
> （注册表条目 + 自定义余额接口）。字段级契约见 [docs/WHALE-CONTRACT.md](docs/WHALE-CONTRACT.md)。

## 特性

- **设置页配置**：DSH 设置 →「中转站」里填中转站地址、凭据名、挂件条目与同步参数；保存后**立即热生效**，
  并写入 `$DSH_HOME/whale-newapi-bridge-settings.json`。设置文件优先于 `cordis.patch.yml`，可一键恢复默认。
- **本机余额桥**：`GET /dsh-whale-newapi/balance` 把中转站余额归一化成稳定 JSON，供挂件直接消费。
- **自动维护挂件条目**：启动即同步，之后每 `syncIntervalSeconds` 同步；只 upsert 自己的
  `id = newapi_relay` 条目，其它模型与 `usage` 账本原样保留；上游失败时**不改写**注册表。
- **两种鉴权模式自动探测**：系统访问令牌（`/api/user/self`，可显示数字余额）与 `sk-` 渠道 key
  （`/v1/dashboard/billing/*`，兼容旧站点）按 key 形态自动排序尝试。
- **回环安全栅栏**：6 条路由都要求 Host 是回环、拒绝 `Sec-Fetch-Site: cross-site`、Origin 必须同源；
  `/balance` 与 `/sync` 还要求 `Authorization: Bearer <凭据值>` 与解析到的凭据逐字节相等。
- **可诊断**：`/status` 输出配置、凭据来源（脱敏）、上游响应、注册表状态与被吞掉的异常。

## 前置条件

1. DSH `>= 0.2.0-rc.1`（宿主提供 credentials 服务、Web 路由注册与 `settings.section` 插槽）。
2. 小鲸鱼挂件 `dsh-whale-widget >= 0.4.2` 已安装并启用。
3. 一个可访问的 New API 站点（在 `v1.0.0-rc.40` 上实测），以及以下之一：
   - **系统访问令牌**（站点后台「个人设置 → 系统访问令牌」，通常 `nap_` 开头）：推荐，能显示数字余额；
   - 渠道 key（`sk-` 开头）：只能走 `events` 模式（余额显示「—」，但会在挂件里记事件账）。

## 快速开始

### 1. 安装插件

```sh
dsh plugin --profile desktop add github:zuaonew-ops/dsh-whale-newapi-bridge
```

- `desktop` 是桌面版默认 profile，按实际情况替换。
- 固定提交：`github:zuaonew-ops/dsh-whale-newapi-bridge#<commit-sha>`。
- 卸载：`dsh plugin --profile desktop remove dsh-whale-newapi-bridge`。

`dsh plugin add` 会转发给 profile 内的 pnpm，并把声明了 `dsh.bundle` 的本插件同步进
profile `package.json` 的 `dsh.profile.bundles`。安装后检查这两处都出现 `dsh-whale-newapi-bridge`；
bundle 需要**重启宿主**才生效（只改配置则热生效）。没有 `dsh` CLI 时，可用 GUI 插件管理器的
`install_bundle`，`target` 传克隆到本机的仓库绝对路径。

### 2. 在设置页配置（推荐）

重启宿主后打开 **设置 →「中转站」**：

1. 填「中转站地址」：你的 New API 站点根地址（例如 `https://relay.example.com`，**不要**带 `/api` 后缀）。
2. 需要时调整其余项（凭据名、币种、条目名、同步间隔等，见下文「设置项」）。
3. 点「保存」：提示「已保存并热生效」后立刻生效，**不需要重启宿主**。

- 保存内容写到 `%USERPROFILE%\.dsh\whale-newapi-bridge-settings.json`
  （macOS / Linux 为 `$DSH_HOME/whale-newapi-bridge-settings.json`），只包含你改过的键。
- 优先级：**设置文件 > `cordis.patch.yml` > 内置默认**。点「恢复默认」会删除设置文件并回退到 yml / 默认值。
- 设置页顶部会显示当前生效来源、凭据解析结果、最近同步、余额与警告（每 5 秒刷新一次）。
- 设置文件不是合法 JSON 或被手工改坏时，插件整体回退 yml 并在 `/status` 的 `warnings` 里说明；
  坏文件不会被自动覆盖，修好（或保存一次合法值）即可恢复。

#### 可选：用 `cordis.patch.yml` 提供基线配置

无头部署或想给多台机器统一默认值时，可在 `<profile>/cordis.patch.yml` 追加：

```yaml
- id: whale-newapi-bridge
  name: dsh-whale-newapi-bridge
  config:
    baseUrl: https://relay.example.com   # 你的 New API 站点根地址
    currency: CNY
    autoSync: true
    syncIntervalSeconds: 300
```

`id` 与 `name` 必须与 bundle 的挂载声明一致（本插件自带，无需修改）。设置页保存的值会覆盖同名键，
其余键继续取 yml。只改 yml 的 `config` 同样热生效。

### 3. 写入凭据

把系统访问令牌写进 `%USERPROFILE%\.dsh\.credentials.yaml` 的 `refs:` 段
（缩进两个空格，值不要加引号）：

```yaml
refs:
  NEWAPI_RELAY_TOKEN: <你的系统访问令牌>
```

- 用 `sk-` 渠道 key 也可以，但只能走 `events` 模式。
- 改凭据不需要重启：DSH 凭据服务每次操作重新解析。
- DSH 界面里没有凭据编辑页时，直接编辑该 YAML 即可；注意不要覆盖其它 ref（例如模型 provider 的 key）。

### 4. 重启宿主并刷新挂件

- 安装/卸载插件后需要**重启 DSH 宿主**（桌面客户端退出重开）；只改配置/设置页保存则热生效。
- 挂件的泡泡配置只在页面加载时读取一次 → 改完刷新页面（`Ctrl+R`）。

### 5. 在挂件里添加余额模块

挂件面板 → 泡泡 → 添加「余额」模块 → 模型选「团队中转站」。
插件会在每次同步时按宿主实时端口重写该条目的 `balance.url`，**不要手工写死端口**。

## 设置项

> 以下 16 项都能在 DSH 设置 →「中转站」里修改；保存时逐键校验，非法值会显示在字段下方且**不会落盘**。

| 键 | 默认 | 说明 |
|---|---|---|
| `baseUrl` | `http://127.0.0.1:3000` | New API 站点根地址（安装后请填成你的站点） |
| `credentialRef` | `NEWAPI_RELAY_TOKEN` | 首选凭据名（建议放系统访问令牌） |
| `credentialCandidates` | `[NEWAPI_RELAY_TOKEN, NEWAPI_API_KEY, PI_API_KEY]` | 首选解析不到时按序尝试 |
| `authMode` | `auto` | `auto`：`sk-` 开头先走 compat（billing），其它先走 native（`/api/user/self`）；可强制 `native` / `compat` |
| `userId` | `(空)` | native 模式可选带 `New-Api-User` 头（rc.40 不需要） |
| `modelId` / `modelName` | `newapi_relay` / `团队中转站` | 写进 `.dshw-api.json` 的条目 id 与挂件显示名 |
| `currency` | `CNY` | 下发币种，`CNY` 或 `USD` |
| `usdToCny` | `0` | `0` = 用 `/api/status` 的 `usd_exchange_rate`；见下方「币种口径」 |
| `quotaPerUnit` | `0` | `0` = 用 `/api/status` 的 `quota_per_unit` |
| `fallbackTotal` | `0` | `0` = 无；`>0` 时无限额度账户也给出 `remaining = fallbackTotal - 累计已用` |
| `bridgeBaseUrl` | `(空)` | 空 = 自动探测宿主实时 origin（只接受回环地址） |
| `autoSync` / `syncIntervalSeconds` | `true` / `300` | 启动时与周期性同步挂件条目（5–86400 秒） |
| `requestTimeoutMs` | `15000` | 上游请求超时（1000–120000 毫秒）；`/balance` 另有 12s 总预算 |
| `enabled` | `true` | `false` = 删除本插件写入的条目，`/balance`、`/sync` 返回 503（`/status`、`/health` 仍 200） |

### 币种口径

余额数字的算法是：`remaining = credits / quotaPerUnit × rate`，其中
`rate = currency === 'CNY' ? usdToCny : 1`。`credits` 来自 `/api/user/self` 的 `quota` / `remain_quota`，
`quotaPerUnit` 一般由站点 `/api/status` 给出（常见 `500000`，也有站点是 `1e10` 等自定义值，
以 `/status` 里显示的为准）。

- 站点面板按 **USD** 显示：`currency: USD`、`usdToCny: 0`（`rate = 1`）→ 数字与面板一致，标签 `$`。
- 站点面板按 **CNY** 显示：`currency: CNY`、`usdToCny: 0` → 用站点 `usd_exchange_rate` 自动换算。
- 站点面板按**自定义币种**（如 `credits`）显示：面板数字通常等于 `credits / quotaPerUnit`
  （自定义汇率为 1 时）。要显示同样的数字，用 `currency: USD`（`$` 标签）或
  `currency: CNY` + `usdToCny: 1`（`¥` 标签）；用 `usdToCny: 7.3` 会把数字放大成面板的 7.3 倍。

## 设置文件与优先级

- 路径：`$DSH_HOME/whale-newapi-bridge-settings.json`；Windows 通常是
  `%USERPROFILE%\.dsh\whale-newapi-bridge-settings.json`。
- 内容：只保存你改过的键（固定键序、2 空格缩进、UTF-8、权限 `0600`），**不含凭据明文**。
- 生效：设置页保存后立即热生效并触发一次同步；手工编辑该文件需要重启宿主才读取。
- 优先级：设置文件 > `cordis.patch.yml` 的 `config` > 内置默认。
- 恢复默认：设置页「恢复默认」或 `POST /dsh-whale-newapi/settings/reset`，删除设置文件并回退 yml / 默认值。
- 文件损坏：整体忽略该文件、回退 yml，并在 `/status.warnings` 与设置页警告区给出原因。

## 余额模式

| 模式 | 触发条件 | 挂件里的表现 |
|---|---|---|
| `balance` | 能取到有限数值余额：系统访问令牌 → `/api/user/self`；或 billing 接口返回非哨兵值；或配置了 `fallbackTotal` | 显示数字余额；「今日已用」按余额下降额记账 |
| `events` | 账户是无限额度（billing 返回哨兵 `hard_limit_usd = 100000000`）且没有 `fallbackTotal`、也拿不到系统访问令牌 | 余额显示「—」；「今日已用」按本机会话事件估算；`/status` 里仍能看到站点累计已用 |

> 为什么需要系统访问令牌：New API 的 `sk-` 渠道 key 在多数站点是 unlimited 令牌，
> `billing` 接口返回 `100000000` 这个**哨兵值**（与账户余额无关）。真实余额要走用户级
> `/api/user/self`，它只认**系统访问令牌**。协议细节见 [docs/PROTOCOL.md](docs/PROTOCOL.md)。

## HTTP 接口（仅回环地址可访问）

| 路由 | 鉴权 | 用途 |
|---|---|---|
| `GET /dsh-whale-newapi/health` | 无 | 自检：`{ok, name, version, enabled}` |
| `GET /dsh-whale-newapi/status` | 无（只读、已脱敏） | 诊断：`config / credential / upstream / whale / bridge / settings / warnings` |
| `GET /dsh-whale-newapi/balance` | `Authorization: Bearer <凭据值>`（或 `?token=`） | 小鲸鱼消费：`{ok, remaining, currency, total, used, unlimited, source, fetchedAt, label, note}`；失败为 `{ok:false, code, error}`（HTTP 200） |
| `POST /dsh-whale-newapi/sync` | 同 `/balance` | 强制重新取数并重写挂件条目；body 可选 `{bridgeBaseUrl?, credentialRef?, modelId?, fallbackTotal?}` |
| `GET /dsh-whale-newapi/settings` | 无（只读；仅回环同源） | 设置页读取：`{ok, version, config, persisted, settingsPath, sync, credential, balance, warnings}` |
| `POST /dsh-whale-newapi/settings` | 无（仅回环同源） | 设置页保存：body 为扁平补丁；200 `{ok, config, persisted, applied}`；400 `{ok:false, code:'BAD_SETTINGS', fields}`；500 `SAVE_FAILED` |
| `POST /dsh-whale-newapi/settings/reset` | 无（仅回环同源） | 删除设置文件并回退：`{ok:true, config, persisted:{}}` |

路由挂在 DSH 宿主的 Web 端口上；端口可用 `/status` 的 `bridge.baseUrl` 或 DSH 界面地址确认。
六条路由都先过回环信任栅栏：`Host` 必须是回环、`Sec-Fetch-Site: cross-site` 拒绝、
`Origin` 与本机不同源则 `403`。

## 安全模型

- 配置文件与设置文件里只有凭据名；凭据值由 DSH 凭据服务在内存中解析，仅传给 `baseUrl` 指向的站点与本机桥。
- `/balance`、`/sync` 的 Bearer 与解析到的凭据值做恒定时间比较，不一致返回 401。
- `/settings` 的读写接口同样只允许回环同源；保存前逐键校验（URL 协议、凭据名、枚举、数值范围），
  非法补丁返回字段级错误并且**不落盘**。
- `bridgeBaseUrl` 只接受回环 origin——它决定挂件把凭据发往哪里。
- 响应、错误与 `/status` 均不含凭据明文（统一 `sk-***` / `len=N`）。设置文件里也不会出现凭据值。
- 写 `.dshw-api.json` 前必须先成功读到它；坏 JSON 只报错不覆盖；写入是原子的
  （临时文件 + rename），首次修改前备份 `<file>.bak-newapi-bridge`。
- 只增删自己的条目，逐字段保留其它模型与 `usage` 账本。

## 目录结构

```
client.js               设置页（浏览器模块，settings.section 插槽，无构建步骤）
lib/index.js            宿主插件：6 条路由 + 栅栏 + 凭据解析 + 设置热生效 + 同步调度
lib/settings.mjs        设置文件读写、逐键校验与恢复默认
lib/newapi.mjs          New API 客户端与余额归一化（纯函数 + 可注入 fetch）
lib/config.mjs          配置默认值与归一化（非法值回退并记 warning）
lib/whale-contract.mjs  小鲸鱼条目契约（balance / events 两种形状）
lib/whale-registry.mjs  .dshw-api.json 的原子读改写（只碰自己的条目）
cordis.patch.yml        bundle 挂载声明（insert 一行）
SPEC.md                 接口契约存档（spec-v2，含设置页路由）
docs/PROTOCOL.md        中转站协议规格（结论附源码 / 实测来源）
docs/WHALE-CONTRACT.md  条目字段与小鲸鱼源码行号的逐条对应
docs/VERIFICATION.md    作者本机的实测验证记录（路径已脱敏）
docs/INSTALL.md         安装、配置、验证、回滚与排障
test/                   离线单测、契约、安全、设置页与真实链路脚本
```

## 开发与测试

```sh
node test/verify-newapi.mjs           # 归一化 / 协议解析
node test/verify-whale-registry.mjs
node test/verify-contract.mjs
node test/verify-security.mjs
node test/verify-spec-v2.mjs
node test/verify-credential-refresh.mjs
node test/verify-settings.mjs         # 设置文件 + /settings + 热生效
node test/verify-live-origin.mjs
node test/live-e2e.mjs --no-write     # 真实站点链路（需配置凭据）
```

前 8 个离线套件合计 358 项断言，当前全绿。`test/fixtures/` 内是脱敏后的真实响应样本。
`live-e2e.mjs` 默认只读，写操作 / 回滚需要显式开关（见脚本头部说明）。

## 兼容性

- New API `v1.0.0-rc.40` 实测；One API 兼容分支的 `/api/status`、`/api/user/self`、
  `/v1/dashboard/billing/*` 契约相同。
- 小鲸鱼挂件 `0.4.2` 实测；注册表与条目形状见 [docs/WHALE-CONTRACT.md](docs/WHALE-CONTRACT.md)。
- DSH `>= 0.2.0-rc.1`；设置页依赖 `settings.section` 插槽与 `client.js` 浏览器模块。
- 详细实测输出见 [docs/VERIFICATION.md](docs/VERIFICATION.md)。

## License

[MIT](LICENSE) © 2026 zuaonew-ops
