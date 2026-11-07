# 安装 / 配置 / 验证 / 回滚

本文面向第一次安装的用户。协议细节见 [PROTOCOL.md](PROTOCOL.md)，
挂件条目契约见 [WHALE-CONTRACT.md](WHALE-CONTRACT.md)，实测记录见 [VERIFICATION.md](VERIFICATION.md)。

## 0. 前置条件

- DSH `>= 0.2.0-rc.1`（提供 `settings.section` 插槽与 `client.js` 浏览器模块加载），
  且小鲸鱼挂件 `dsh-whale-widget >= 0.4.2` 已启用。
- 一个可访问的 New API 站点（`v1.0.0-rc.40` 实测）。
- 知道 DSH 的 profile 目录：默认 `%USERPROFILE%\.dsh\profiles\desktop`（Windows）；
  macOS / Linux 为 `$DSH_HOME/profiles/desktop`。
- 站点凭据二选一：
  - **系统访问令牌**（个人设置 → 系统访问令牌，通常 `nap_` 开头）：能取到数字余额，推荐；
  - 渠道 key（`sk-` 开头）：只能走 `events` 模式。

## 1. 安装插件

### 1.1 用 DSH CLI（推荐）

```sh
dsh plugin --profile desktop add github:zuaonew-ops/dsh-whale-newapi-bridge
```

`dsh plugin add` 会把包装进 profile 的 `node_modules`；包声明了 `dsh.bundle` 时，
DSH 会自动把它加入 profile `package.json` 的 `dsh.profile.bundles`。

- 固定版本：`github:zuaonew-ops/dsh-whale-newapi-bridge#<commit-sha>`。
- 卸载：`dsh plugin --profile desktop remove dsh-whale-newapi-bridge`。

### 1.2 用 GUI 插件管理器

在 DSH 的插件管理器里执行 `install_bundle`，`target` 传克隆到本机的仓库绝对路径。
不同版本的管理器参数略有差异，按其提示填写。

安装成功后，`%USERPROFILE%\.dsh\profiles\desktop\package.json` 的
`dependencies` 与 `dsh.profile.bundles` 里都应出现 `dsh-whale-newapi-bridge`。

安装/升级后必须**重启宿主**（桌面客户端退出重开），bundle 才会加载；设置页与路由随之出现。

## 2. 在设置页配置（推荐）

重启宿主后：**设置 →「中转站」**（设置页左侧导航）。页面每 5 秒刷新一次当前状态。

1. 填「中转站地址」：你的 New API 站点根地址，例如 `https://relay.example.com`。
   不要带 `/api` 后缀或尾斜杠。
2. 按需调整其余项：
   - 「凭据名」：默认 `NEWAPI_RELAY_TOKEN`（与第 3 节写入的 ref 对应）；
   - 「候选凭据」：首选解析不到时按顺序回退，逗号或换行分隔；
   - 「币种」与「USD 到 CNY 汇率」：见 README 的「币种口径」；
   - 「条目 id / 显示名」：写进挂件注册表的模型 id 与挂件里显示的名字；
   - 「同步间隔」「请求超时」：同步与上游请求参数；
   - 「启用插件」：关闭会移除本插件写入的挂件条目。
3. 点「保存」：提示「已保存并热生效」即完成，**不用重启宿主**；保存会自动触发一次同步。
4. 想看最新余额/同步结果，点「刷新」或等 5 秒轮询。

设置页顶部状态区会显示：生效配置来源、设置文件路径、凭据解析结果、最近同步、余额与警告。

- 保存内容写到 `%USERPROFILE%\.dsh\whale-newapi-bridge-settings.json`
  （macOS / Linux 为 `$DSH_HOME/whale-newapi-bridge-settings.json`），只含改过的键。
- 优先级：**设置文件 > `cordis.patch.yml` 的 `config` > 内置默认**。
- 字段校验失败时，错误显示在对应输入框下方，本次保存**不会写文件**（不会半写）。

### 2.1 可选：用 `cordis.patch.yml` 提供基线配置

无头部署或需要统一默认值时，可在 profile 的 `cordis.patch.yml` 末尾追加：

```yaml
- id: whale-newapi-bridge
  name: dsh-whale-newapi-bridge
  config:
    baseUrl: https://relay.example.com   # 你的 New API 站点根地址
    credentialRef: NEWAPI_RELAY_TOKEN
    credentialCandidates:
      - NEWAPI_RELAY_TOKEN
      - NEWAPI_API_KEY
      - PI_API_KEY
    authMode: auto
    modelId: newapi_relay
    modelName: 团队中转站
    currency: USD
    usdToCny: 0
    autoSync: true
    syncIntervalSeconds: 300
```

说明：

- `id` 与 `name` 必须与 bundle 声明一致，否则配置不会作用到插件上。
- `baseUrl` 不要带 `/api` 后缀，也不要带尾斜杠。
- 币种与换算见 README 的「币种口径」。常见配置：
  - 站点面板 USD：`currency: USD`、`usdToCny: 0`
  - 站点面板 CNY：`currency: CNY`、`usdToCny: 0`
  - 面板自定义币种（`credits` 等）：`currency: USD`，或 `currency: CNY` + `usdToCny: 1`
- `bridgeBaseUrl` 留空即可：插件按 `DSH_WEB_URL` → 宿主实时 origin → `DSHW_WEB_PORT` / `PORT`
  → `argv --port=` → `127.0.0.1:19387` 的顺序探测，且每次同步都重做，端口变化会自动修正。
  只接受回环地址；手工指定为局域网地址会被拒绝（400）。
- 改配置**热生效**，不用重启宿主。设置页保存的值会覆盖同名键，其余键继续取 yml。

### 2.2 生效时机

| 动作 | 生效方式 |
|---|---|
| 设置页保存 | 立即热生效（配置 + 重启同步定时器 + 触发一次同步） |
| 手工编辑设置文件 `whale-newapi-bridge-settings.json` | 重启宿主后才读取 |
| 改 `cordis.patch.yml` 的 `config` | 宿主热应用，下一次路由请求 / 同步即用新值 |
| 安装 / 卸载 / 升级插件包 | 需要重启 DSH 宿主（桌面客户端退出重开） |
| 改插件源码（`lib/*.js`、`client.js`） | 必须重启宿主（Node ESM 模块缓存） |
| 改挂件泡泡配置（`.dshw-bubble.json`） | 刷新页面（`Ctrl+R`）；挂件只在页面加载时读取 |

代码变更为什么不能热重载：DSH 的插件加载器是裸 `await import(...)`（不追加缓存破坏串），
而 HMR 的默认 `ignored` 规则排除 `node_modules`；本插件恰好装在 `<profile>/node_modules/` 下，
所以 watcher 与依赖图都会跳过它。结论：改代码一律「更新安装副本 → 重启宿主」。

### 2.3 重置或删除设置文件

- 设置页「恢复默认」：删除设置文件并回退到 yml / 内置默认值（也会热生效）。
- 等价接口：`POST /dsh-whale-newapi/settings/reset`。
- 手工删除：删掉 `%USERPROFILE%\.dsh\whale-newapi-bridge-settings.json` 后重启宿主，
  效果同样是回退 yml / 默认值。
- 设置文件损坏（不是合法 JSON）时，插件整体忽略它、回退 yml，并在 `/status.warnings`
  与设置页警告区说明原因；坏文件不会被自动覆盖，保存一次合法值即可自愈。

## 3. 填凭据

### 3a. 系统访问令牌（推荐，显示数字余额）

1. 打开站点：个人设置 → **系统访问令牌** → 生成并复制（不要用 `sk-` 渠道 key）。
2. 写进 `%USERPROFILE%\.dsh\.credentials.yaml` 的 `refs:` 段：

```yaml
refs:
  NEWAPI_RELAY_TOKEN: <粘贴系统访问令牌>
```

   缩进两个空格、值不加引号；文件里其它 ref 保持原样。保存即可，**不需要重启**：
   凭据服务每次操作重新解析。
3. 等下一轮同步（不超过 `syncIntervalSeconds`），或在设置页点「保存」/「刷新」，
   或手动 `POST /sync`：`/status` 里 `whale.mode` 变成 `balance`，挂件出现数字余额。

> 若 DSH 界面没有凭据编辑页：直接编辑该 YAML 是唯一干净的做法。
> 模型设置里的 API Key 输入框只会写该 provider 自己的 ref，不能创建任意名字的 `NEWAPI_RELAY_TOKEN`。

### 3b. 只有渠道 key（`events` 模式）

`sk-` key 是 unlimited 令牌时，billing 接口只返回哨兵值，插件把条目降级为 `events`：
挂件显示「余额 —」+ 本机会话估算的今日已用，`/status` 里仍能看到站点累计已用。
若知道账户总额度，也可在设置页把「人工总额度」（`fallbackTotal`）填成总额，
插件会显示 `总额 − 累计已用`。

## 4. 验证

先确认插件活着（换成你的实际端口；桌面版端口每次启动可能不同）：

```sh
curl -s http://127.0.0.1:<端口>/dsh-whale-newapi/health
curl -s http://127.0.0.1:<端口>/dsh-whale-newapi/status
curl -s http://127.0.0.1:<端口>/dsh-whale-newapi/settings
```

`/status` 关键字段：

- `config.baseUrl`：配置是否生效；
- `credential.{ref,present,source}`：当前解析到的凭据名与来源（`config` / `candidate`）；
- `upstream.{relay,auth}`：上游 `/api/status` 与鉴权尝试结果；
- `whale.{id,mode,entry,registryFile,lastSyncAt,lastSyncResult}`：挂件条目同步状态；
- `settings.{file,persistedKeys}`：设置文件路径与当前覆盖了哪些键；
- `warnings`：不致命的提示（如模型列表取不到、币种口径提醒）。

`/settings` 应返回 `{ok:true, config:{…16 项…}, persisted:{…}}`；`persisted` 为空表示当前没有设置文件覆盖。

再触发一次同步并核对注册表（Bearer = 插件实际解析到的凭据值）：

```sh
curl -s -X POST http://127.0.0.1:<端口>/dsh-whale-newapi/sync \
  -H "Authorization: Bearer <凭据值>"
curl -s http://127.0.0.1:<端口>/dsh-whale-newapi/balance \
  -H "Authorization: Bearer <凭据值>"
```

挂件侧：`%USERPROFILE%\.dsh\.dshw-api.json` 里应有 `id = newapi_relay` 的条目，
其 `balance.url` 指向当前端口的 `/dsh-whale-newapi/balance`；
在挂件里给「团队中转站」加余额模块后，应显示数字（或按模式显示「—」）。

Windows PowerShell 等价命令：

```powershell
(Invoke-WebRequest http://127.0.0.1:<端口>/dsh-whale-newapi/status -UseBasicParsing).Content | ConvertFrom-Json
```

## 5. 卸载与回滚

```sh
# 1) 卸载插件（会从 profile 的 package.json / bundles 移除）
dsh plugin --profile desktop remove dsh-whale-newapi-bridge
```

2) 删除本插件写进挂件注册表的条目。推荐用插件自带的注册表模块（只删自己的条目，安全）：

```sh
# 先进入本仓库克隆目录（下面用相对路径 import）
cd <本仓库克隆目录>
node --input-type=module -e "import('./lib/whale-registry.mjs').then((m) => {
  const f = m.resolveWhaleApiFile(process.env.DSH_HOME || process.env.USERPROFILE + '/.dsh')
  const r = m.readWhaleRegistry(f)
  if (!r.ok) throw new Error('read failed: ' + r.error)
  const out = m.removeWhaleEntry(r.registry, 'newapi_relay')
  if (out.changed) { const w = m.writeWhaleRegistryAtomic(f, out.registry); console.log('removed, backup=' + w.backupPath) }
  else { console.log('no entry, unchanged') }
})"
```

3) 删除设置文件（保留也无害，重装后会继续生效）：

```sh
rm "%USERPROFILE%\.dsh\whale-newapi-bridge-settings.json"   # Windows
rm "$DSH_HOME/whale-newapi-bridge-settings.json"             # macOS / Linux
```

4) 还原 `cordis.patch.yml`（安装前备份），重启宿主。

**注意**：`<file>.bak-newapi-bridge` 是插件**第一次改写**时留下的备份，它本身已含
`newapi_relay` 条目，**不能**拿它覆盖注册表来回滚（会保留条目并清空宿主累计的 `usage` 账本）。
它只能当历史留档；干净回滚的做法是上面第 2 步。

若只想临时停用：设置页关掉「启用插件」（或配置里 `enabled: false`），插件会自行删掉条目并让
`/balance`、`/sync` 返回 503（`/status`、`/health` 仍 200）。

## 6. 故障排查

| 现象 | 原因与处理 |
|---|---|
| 设置里没有「中转站」 | bundle 没加载或前端缓存：确认 profile `package.json` 的 `dsh.profile.bundles` 有它；重启宿主；刷新页面（`Ctrl+R`） |
| 设置页一直「加载中…」 | `/settings` 路由 404 或桥没启动：先 `curl /dsh-whale-newapi/health`；确认宿主版本支持 `settings.section`，重启宿主 |
| 保存返回 400（`BAD_SETTINGS`） | 字段非法：按输入框下方红字修正；常见是中转站地址不是 http(s)、凭据名含非法字符、数值越界 |
| 保存提示「没有需要保存的改动」 | 表单值与当前生效值相同，无需写文件 |
| 设置页显示警告且值没生效 | 设置文件损坏或含未知键：看警告里逐键的原因；保存一次合法值或「恢复默认」即可 |
| `/dsh-whale-newapi/*` 全 404 | bundle 没加载：确认 profile `package.json` 的 `dsh.profile.bundles` 有它；重启宿主；看插件管理器日志 |
| `/balance` 或 `/sync` 401 | Bearer 与插件实际解析到的凭据不一致；看 `/status.credential.ref` 确认当前用的是哪个 ref |
| `/sync` 400 | `bridgeBaseUrl` 不是回环地址（有意的安全限制） |
| `/status` 里 `upstream.code = NETWORK` | `baseUrl` 不可达：检查站点地址、DNS、代理、防火墙 |
| `upstream.code = HTTP`（401 / 403） | 凭据与站点不匹配：系统访问令牌与 `sk-` 渠道 key 不能混用 |
| `upstream.code = SHAPE` | 站点返回结构不符：用 `curl <baseUrl>/api/user/self -H "Authorization: Bearer <令牌>"` 对照字段 |
| 挂件「余额 —」 | 处于 `events` 模式（无限额度 / 无系统令牌）：按 3a 配系统访问令牌，或配 `fallbackTotal` |
| 挂件数字是面板的 7.3 倍 | `usdToCny` 配成了 7.3；按「币种口径」调整 |
| 挂件提示「未配置 <keyRef>」 | 条目 `keyRef` 指向的凭据不存在；等下一轮同步切到候选，或按 3a 创建该 ref |
| 从局域网 / 反代访问 403 | 栅栏只认回环；用 `DSHW_TRUSTED_HOSTS` 显式声明权威主机 |
| 端口不是默认值 | 插件自动探测实时端口；也可显式配 `bridgeBaseUrl: http://127.0.0.1:<端口>` 后 `POST /sync` |
| 改了代码但行为没变 | ESM 缓存：重启宿主；并确认安装副本已更新（`file:` 目录是复制安装） |

## 7. 兼容性与实测

- New API `v1.0.0-rc.40`：`/api/status`、`/api/user/self`、`/v1/dashboard/billing/*` 实测可用。
- DSH `>= 0.2.0-rc.1`：设置页依赖 `settings.section` 插槽与 `client.js` 浏览器模块。
- 离线测试与真实链路测试的逐项结论见 [VERIFICATION.md](VERIFICATION.md)。
- 挂件条目契约、字段路径与源码行号见 [WHALE-CONTRACT.md](WHALE-CONTRACT.md)。
