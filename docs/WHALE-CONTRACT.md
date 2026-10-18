# 小鲸鱼条目契约（WHALE-CONTRACT）

> 归属：**bridge**（`lib/whale-registry.mjs`、`lib/whale-contract.mjs`）。
> 冻结来源：`SPEC.md` `spec-v1` §5.2 / §5.3 / §6.1 / §7。
> 本文所有行号均指宿主源码
> `%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-whale-widget\lib\index.js`
> （`dsh-whale-widget@0.3.18`，共 4198 行）。行号已逐条 `read` 核对，不是凭印象。
>
> 挂件升级会重排行号（如 0.4.2 已重排），因此 `test/verify-contract.mjs` 的证据①按**内容定位**
> 核对：语句仍在已安装的挂件源码里即通过，并打印「记录行号 → 实际行号」的漂移；语句消失才判失败。
> 契约语义本身由证据②判定链复刻 + 真实回环服务端独立证明。

---

## 0. 一句话

我们**不碰小鲸鱼一行代码**，只往 `$DSH_HOME/.dshw-api.json` 里维护**一条** `provider:"custom"`
模型条目，让宿主自己去 `balance.url` 取余额。宿主负责取数、显示、记账；我们只负责
「条目形状正确」+「注册表其它内容一字不动」。

---

## 1. 接口面：注册表文件

| 事实 | 源码位置 | 对我们的约束 |
|---|---|---|
| 候选表 `$DSH_HOME/.dshw-api.json` **优先** | 第 87-92 行 | 我们**只写首选路径**（`resolveWhaleApiFile`） |
| 读：`JSON.parse` 后要求 `Array.isArray(parsed.models)`，否则**静默跳过**该候选 | 第 1953-1964 行 | 我们写坏文件 = 用户所有自定义模型一起消失（第 1961-1963 行 catch + 回落默认） |
| 读：`parsed.usage` 不是对象时**就地补成 `{}`** | 第 1958 行 | `usage` 丢键是**不可逆**的数据损失，必须逐字段保留 |
| 写：`JSON.stringify(reg, null, 2)` + UTF-8，直接 `writeFileSync` | 第 1965-1971 行 | 我们沿用同样的字节风格（2 空格缩进 + UTF-8），并改成**原子写** |
| `id === 'deepseek'` 的条目被过滤（内置模型由宿主合成，不进文件） | 第 1976-1983 行 | 我们的 id 不能叫 `deepseek`（默认 `newapi_relay`） |
| 宿主每次取余额后会**回写整个注册表**（`apiRecordBalance` → `writeApiRegistry`） | 第 2394-2410 行 | 文件是**双方共享**的：并发写必须有原子写 + 只动自己那条 |

### 写注册表的四条不变量（`lib/whale-registry.mjs`）

1. **只替换 `id` 命中的那一条**：其它 `models` 条目对象**原样引用**（不重建 → 键序与未知字段一字不改）。
2. **`usage` 原样保留**：`usage[id]` 是小鲸鱼的账本（第 2394-2410 行写入 `day/dayStart/lastBalance/delta/eventCost/eventTokens/currency`），
   我们连 `removeWhaleEntry` 都**不删**它 —— 删了宿主下次重写会写回来，只多一次 mtime 抖动。
3. **原子写**：同目录临时文件 + `rename`。原因：宿主在第 1956 行读整个文件，直接原地覆盖存在
   「读到半截 JSON」的窗口 → 宿主判为坏文件 → 用户**全部**模型余额消失。
4. **首次修改前备份** `<file>.bak-newapi-bridge`（已存在**不覆盖**），用 `fs.linkSync` +
   `COPYFILE_EXCL` 兜底，避免 `existsSync → copyFileSync` 的竞争窗口。
   备份 == 小鲸鱼接手前的原文件，正好是 SPEC §8 A7 回滚要的那一份。
5. **目标目录必须已存在**：SPEC §5.3 的路径永远是 `$DSH_HOME`（必然存在），所以
   目标目录缺失属于**配置错误**，必须显式 `ok:false` 报出来，**不**悄悄 `mkdir -p` 掩盖问题。
6. **`WHALE_API_FILE` 在两个模块都导出且恒等**：SPEC §5.2 把它归在 `whale-contract.mjs`，
   而 SPEC §5.3 的导出清单又列了它 —— 两边导出同一个值（`C.WHALE_API_FILE === R.WHALE_API_FILE`），
   独立消费者（如 `test/verify-whale-registry.mjs`）从任一模块 import 都成立。

`changed === false` 时**不落盘**：内容没变就重写只会让 mtime 抖动，而宿主按文件读取、
无谓重写会让它反复重新解析整个注册表。

---

## 2. 字段逐个为什么这么填（`mode:'balance'`）

对应 `buildWhaleEntry(cfg, ctxInfo)` 的产物：

```json
{
  "id": "newapi_relay",
  "name": "团队中转站",
  "provider": "custom",
  "currency": "CNY",
  "keyRef": "PI_API_KEY",
  "baseUrl": "https://relay.example.com",
  "balance": {
    "url": "http://127.0.0.1:19387/dsh-whale-newapi/balance",
    "auth": "Bearer {key}",
    "json": { "remaining": "remaining" }
  },
  "matchIds": ["deepseek-v4.1-flash", "tier-max", "tier-power", "tier-std"],
  "allowCustomHost": true
}
```

| 字段 | 为什么是这个值 | 源码依据 |
|---|---|---|
| `id` | 宿主按 id 定位条目（`apiModelById`）。只允许 `[A-Za-z0-9_-]`（SPEC §4），模块内对非法字符做 `_` 替换 | 第 1984-1987 行 |
| `name` | 挂件面板里显示的模型名；同时派生「余额·<模型名>」泡泡模块标题 | 第 2716 行 `name: m.name` |
| `provider` | 必须是 `custom`。这决定了 `apiTemplateOf('custom') === null` → `tpl = {}` → 合并基线为空，**条目自带的一切就是全部**（不会被某厂商模板的 `balance.url` 意外覆盖） | 第 1972-1974、2346-2347 行 |
| `currency` | 下发币种，直接进 `entry.currency`；同时决定 `apiTodayUsage(id, currency)` 的展示币种 | 第 2716、2800、2802 行 |
| `keyRef` | **必须是已存在的凭据名**。宿主 `credentials.resolve(keyRef)` 解析不到 → `code:'NO_KEY'` / `entry.error='未配置 <keyRef>'`，余额永远查不到 | 第 2104-2107、2773-2776、2811-2813 行 |
| `baseUrl` | 中转站根地址。`{base}` 占位符由它替换（我们自己的 URL 不含 `{base}`，此字段主要供面板回填与人类排查） | 第 2349-2350 行 |
| `balance.url` | 指向**本机回环**路由 `/dsh-whale-newapi/balance`（SPEC §6.1）。回环地址是被允许的：第 2033-2038 行注释明确说不拦回环与内网，New API 自建网关就是正当用法 | 第 2040-2055、2350 行 |
| `balance.auth` | 字面量 `"Bearer {key}"`。`apiFetchJson` 做 `String(auth).replace('{key}', key)` —— 真实凭据**只存在于宿主内存**，绝不进注册表文件 | 第 2145-2146 行 |
| `balance.json.remaining` | `"remaining"` 是 JSON 路径，含义「响应体顶层 `remaining`」。支持 `a.b[0].c` 与可选 `scale`；我们路由的顶层就返回 `remaining`，所以最简路径最稳 | 第 1988-1999、2362 行 |
| `matchIds` | 把**会话里出现的模型名**对到我们这条条目上。匹配是**大小写不敏感的子串包含**（`name.indexOf(k) >= 0`，第 2456-2471 行），且**取注册表里第一条命中**。本机中转站 `/v1/models` 实测 `deepseek-v4.1-flash / tier-max / tier-power / tier-std`（SPEC §1）都是精确全名，做子串也必然命中 | 第 2456-2471、2560-2565、2730 行 |
| `allowCustomHost` | **必须 `true`**，见下一节 | 第 2084-2089 行 |

### 2.1 为什么 `allowCustomHost` 必须是 `true`（安全设计逼出来的）

宿主 v761 起有「凭据目的地白名单」：

* `credentialMayGoTo(model, tpl, url)`：目标 origin 命中 `templateOrigins(tpl)` → 放行；
  否则**必须** `model.allowCustomHost === true`（第 2084-2089 行）。
* `templateOrigins` 只收模板里写死的 `probeUrl / balance.url / balance.usage.url / quota.url`，
  且**含 `{base}` 的模板 URL 一律不算可信**（第 2070-2082 行第 2074 行过滤）。
* `provider:'custom'` 没有模板 → `templateOrigins` 为空集 → 我们的回环 URL 永远不在白名单里。
* 结论：`allowCustomHost !== true` 时 `keyForDestination` 返回
  `code:'DEST_NOT_ALLOWED'`（第 2108-2115 行），余额**永远取不到**，还会打一条 warn（第 2096-2097 行）。

这条标志**只能由本机（回环）来源的写请求设置**（第 742-773 行 `writeRejection`：写方法 + 非回环 Host → 403），
所以打开它并不会把凭据暴露给远端会话 —— 这正是宿主设计者留下的、给我们这种「本机自建网关」的合法口子。
我们通过**直接写文件**（本机进程）设置它，等价于用户在本机面板勾选「允许把凭据发送到自定义地址」。

### 2.2 端到端验证（已实测，命令见 §5）

把 `buildWhaleEntry` 产出的条目喂给**逐行照抄的第 2142-2163 / 2339-2377 行逻辑**去打一个回环假桥：

```
假桥监听于 http://127.0.0.1:57124/dsh-whale-newapi/balance
[PASS] 第 2348 行 b.url 非空（不会 NO_URL）
[PASS] 桥收到 Authorization: Bearer <key>（占位符被替换）
[PASS] 第 2362 行 json.remaining="remaining" 取到有限数值 — 876.5432
[PASS] 第 2375-2376 行 不会落到 code SHAPE
[PASS] 第 2088 行 credentialMayGoTo=false（关掉 allowCustomHost 的反证）
```

同时确认 Node 的 `fetch` 发出的 `Host` 是 `127.0.0.1:<port>`（回环），能过宿主
第 691-728 行的 `isLoopbackHostname` / `selfRejection` 栅栏 —— 否则小鲸鱼取余额会吃到 403。

---

## 3. 两种模式在小鲸鱼里的可见差异

宿主判定链（第 2744-2826 行）：

* `hasBalanceApi = !!String(balDesc.url || '').trim()`（第 2780 行，`balDesc` = 模板 balance ⊕ 条目 balance）
* `entry.balanceMode = hasBalanceApi ? 'api' : 'events'`（第 2795 行）
* `hasBalanceApi && hasKey` → 真的去 `fetchModelBalance`（第 2796-2808 行）
* `!hasBalanceApi` → `entry.error = null`，**不算错误**（第 2809-2810 行）
* `hasBalanceApi && !hasKey` → `entry.error = '未配置 <keyRef>'`（第 2811-2813 行）

| | `mode:'balance'` | `mode:'events'` |
|---|---|---|
| 条目 `balance.url` | `<bridgeUrl>/dsh-whale-newapi/balance` | **空串**（骨架键保留，见下） |
| `entry.hasBalanceApi` | `true`（第 2780 行） | `false` |
| `entry.balanceMode` | `'api'` | `'events'`（第 2795 行） |
| `entry.balance` | 我们路由返回的 `remaining` **有限数值**（第 2799 行） | `null` |
| 挂件「余额·团队中转站」 | 显示**真实余额数字** | 显示「**—**」 |
| 「今日已用」 | 由**余额差**记账：宿主 `apiRecordBalance` 存 `dayStart/lastBalance/delta`（第 2394-2410 行），`apiTodayUsage` 命中 `lastBalance` 分支 → `source:'balance'`、币种 = 条目币种（第 2420 行） | 由**本机会话事件**估算：`eventCost`，`source:'events'`、币种固定 `CNY`（第 2421 行） |
| `entry.error` | 成功时 `null`；我们路由报业务错时是错误行（第 2806-2807 行） | `null`（第 2810 行，无余额接口不算错误） |
| `needsHostConfirm` | `false`（`allowCustomHost=true` 使 `credentialMayGoTo` 为真，第 2720-2728 行） | 同样 `false` |

> **两种模式都保留 `allowCustomHost: true`**：将来从 events 切回 balance 时不会因为
> 忘了开这个开关而卡在 `DEST_NOT_ALLOWED`。

### 3.1 events 条目为什么要写空串骨架而不是删键

SPEC §5.2 允许「`balance: {"url":"","auth":"","json":{"remaining":""}}` 或省略」。
我们选**空串骨架**，因为宿主在写注册表时用 `stripEmptyDeep`（第 2021-2031 行）把空串/空对象整键删掉，
而读的时候用 `mergeNonEmpty`（第 2009-2019 行）跳过空串 —— 两种写法在宿主侧**等价**，
空串骨架的好处是：面板回填（第 2745 行 `entry.balanceDesc`）能看到字段名，用户不用猜 JSON 路径。

### 3.2 什么时候降级、什么时候**不**降级

`buildWhaleEntry` 的防御性校验（SPEC §5.2 要求）：`mode:'balance'` 只接受**有限数值** `remaining`。

> ⚠️ **判定顺序**：先看「有没有有限 `remaining`」，再看 `unlimited`。
> `unlimited === true` **本身不是降级条件** —— SPEC §4 `fallbackTotal`「>0 时：账户为无限额度也给出
> `remaining = fallbackTotal - used`」、§5.1.1 规则 2、§5.2/§6.1 的 events 定义都是
> 「unlimited **且 `fallbackTotal<=0`**」。顺序写反会让 `fallbackTotal` 这条路径彻底失效，
> 而本机中转站 compat 恒为哨兵 1e8（`unlimited` 恒 `true`），**`fallbackTotal` 正是唯一能让挂件
> 显示数值余额的 compat 路径**（native 需要 PAT）—— 即顺序错误会导致产品目标无法达成。

| 输入（normalizeBalance / 扁平字段） | 结果 | 理由 |
|---|---|---|
| `remaining` 有限数值（**不论 `unlimited` 真假**） | `balance` | 正常路径，也是 `fallbackTotal>0` 的路径；`unlimited:true` 时额外提示「无限额度 + fallbackTotal 兜底」 |
| `remaining` 为 `null` / `NaN` / `Infinity` / 字符串 **且** `unlimited === true` | **→ `events`** + 警告 | 真的没有可下发数值；宿主第 2375-2376 行会把 `null` 判成 `code:'SHAPE'`（红色错误行），比「余额 —」更糟 |
| `remaining` 非有限数值且 `unlimited` 非真 | **→ `events`** + 警告 | 同上：宿主只认 `Number.isFinite`（第 2000-2005 行 `apiNum`） |
| `mode === 'credits'`（非 `money` 口径）但 `remaining` 是有限数值 | **保持 `balance`** + 口径备注 | 宿主只读 `balance.json.remaining` 路径上的数值，`credits/money` 这个标志**不影响挂件展示**。既然 core 已经算出了与面板一致的数值，就不该因为一个装饰性标志把真实余额降级掉。若数值不是有限的，仍走 `events` |
| `cfg.balanceMode === 'events'` 与快照冲突（快照有有限数值） | **→ `events`** + 警告 | core 的口径必须真的落成 events，否则会出现「它算 events、我写成 balance」的静默不一致；只有「上游失败」（下表末行）例外 |
| 没有余额快照（`coverage`/`balance` 缺失） | **→ `events`** + 警告 | 没有依据就不能假装有钱 |
| **上游取数临时失败**（`ok:false` / `cfg.balanceOk === false`，如 `TIMEOUT/NETWORK/HTTP_500`） | **保持 `balance`** + 警告 | 见下 |

**为什么临时失败不降级**：降级会把挂件里的余额从数字变成「—」，用户会以为接入坏了，
而且下一次周期同步可能只是网络抖动。正确表现是 SPEC §6.1 要求的：
`/balance` 回 HTTP 200 + `{ok:false, code, error}` → 宿主转发到 `entry.error`（第 2806-2807 行）→
**挂件显示一行错误**，模式仍是「有余额接口」。这也是 info 语义：坏的是上游，不是接入方式。

---

## 4. 为什么不改小鲸鱼源码

1. **它会被覆盖**：`dsh-whale-widget` 是 npm 安装的第三方包
   （`%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-whale-widget`），
   任何版本升级都会把我们的补丁冲掉；SPEC §0 把「不修改」列为硬约束。
2. **它已经留了扩展面**：注册表 + `balance.url` + `allowCustomHost` 是**作者显式设计**的
   自建网关入口（第 2036-2038 行注释直接点名 New API；第 2097 行的提示语就是
   「若这是你自建/自托管的网关，请在本机面板勾选…」）。走文档化的口子比打补丁更稳。
3. **宿主每次取余额都会重写整个注册表**（第 2407 行）。也就是说注册表是**双方共享的可写状态**，
   我们的正确姿势必须是「只动自己那条 + 逐字段保留其它」，而不是改宿主代码去迁就我们。
4. **失败不得影响宿主**：改宿主代码一旦出错，坏的是用户整个 Web 界面；而插件
   `apply()` 内部全部 try/catch（SPEC §3、§7.5），最坏情况只是余额不显示。
5. 桌面端加载的是 strip 过的发布副本（第 36-38 行注释：`DATA_CANDIDATES_TAIL` 被清空），
   改「开发版路径」在用户机器上根本不生效，反而制造「网页端/桌面端各写各的」类 bug（第 31-34 行抱怨过）。

---

## 5. 自测证据

命令（临时脚本在 `%TEMP%`，**不入交付目录**）：

```powershell
& '%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe' "$env:TEMP\bridge-selftest.mjs"
& '%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe' "$env:TEMP\bridge-host-sim.mjs"
```

结果：四套 **ALL PASS**（self-test 98 条 + host-sim 12 条 + 独立验证 `test/verify-whale-registry.mjs` 30 条 + core 的端到端 `%TEMP%\wnb-selftest\plugin-test.mjs` 87 条 = **227 条断言**）。

被验证的具体版本（SHA256 前 16 位）：

| 文件 | SHA256 | 备注 |
|---|---|---|
| `lib/whale-registry.mjs` | `63169962A211CB70…` | core 已按此哈希复跑通过 |
| `lib/whale-contract.mjs` | `9A64D6EAB7E97CB0…` | 含 `fallbackTotal` 判定顺序修复；core 已按此哈希复跑通过 |
| `docs/WHALE-CONTRACT.md` | 随每次文档编辑变化（§5.2 加入 spec-v2 后为 `2EFF006F53FE625C…`） | 仅文档，不参与运行时 |

```powershell
# 第三方独立验证（由 verify 组维护，不属我的写入范围，仅运行）
& 'C:\...\node.exe' '<repo>\test\verify-whale-registry.mjs'
# → ----- 合计: 30 通过 / 0 失败 (30 项) -----  SUMMARY: PASS

# core 的端到端（真 fs + 真 HTTP 回环），走**真实** bridge 模块
$env:WNB_REAL_BRIDGE='1'; & 'C:\...\node.exe' "$env:TEMP\wnb-selftest\plugin-test.mjs"
# → PASS 87  FAIL 0  （含 /sync fallbackTotal 生效 → mode='balance'、条目带 bridge URL）
```

| 场景 | 断言要点 |
|---|---|
| ① 文件不存在 → 生成注册表 | `ok:true, existed:false, registry={version:1,models:[],usage:{}}`；落盘后回读含我们的条目；重复 upsert 返回 `changed:false`；目标目录缺失 → `ok:false` 且**不自动建目录** |
| ② 已有其它模型 + 大 `usage` → upsert 后深度比对 | 备份文件哈希 == 改动前原文件；其它两条模型逐字段 `deepEqual`；`usage` 52 键含嵌套/数组**零差异**；未来版本顶层键保留；键顺序 `kimi_coding,dummy2,newapi_relay`；`changed:false` 时 mtime 未变（附反证：无条件重写会让 mtime 抖动） |
| ③ 坏 JSON → 拒绝写入 | 截断 JSON / `models` 非数组 / 缺少 `models` / 顶层数组 四种都 `ok:false`；原文件**哈希未变、字节一字未动、未生成备份**；`writeWhaleRegistryAtomic` 自身也拒绝非法注册表 |
| ④ 防御性校验 | ⭐ `unlimited:true` + 有限 `remaining`（`fallbackTotal` 路径）→ **`balance`** 且 `balance.url` 指向桥、**无降级警告**；`unlimited:true` 且 `remaining=null`（含 `total` 有限的情况）→ `events` + 警告；`Infinity` / 字符串 `remaining` / 无快照 → `events`；`mode:'credits'` 但 `remaining` 有限 → 保持 `balance` + 口径备注（见 §3.2）；上游临时失败 → 保持 `balance` + 警告；`allowCustomHost===true`、`json.remaining==='remaining'`、默认 `matchIds` 四条 |
| ⑤ 真实路径只读演练 | `resolveWhaleApiFile()` → `%USERPROFILE%\.dsh\.dshw-api.json`；当前不存在 → `ok:true, existed:false` + 空表；演练后真实文件仍不存在、未产生备份（**零写入**） |
| ⑥ core 的真实调用形状 | `cfg` = 归一化配置 + `balance`/`balanceOk`/`unlimited`/`balanceMode`，`ctxInfo` = `{bridgeUrl,credentialRef,modelId,modelName,currency,matchIds,relayBaseUrl}`：成功 → `balance` 且 `warnings` 为空；`unlimited`+`balanceMode='events'` → `events` 且 `balance.url` 空、仍带 `matchIds/allowCustomHost/keyRef`；`balanceMode` 与快照冲突两种方向都落成一致结果并各记一条 warning；`balance.ok:false` 快照 → 保持 `balance`；`entry` 可 `JSON.stringify` 往返且无 `sk-` 明文 |
| ⑦ 宿主路径仿真 | 照抄宿主的 `pickJsonPath`/`apiNum`/`apiFetchJson`/`selfRejection` 打回环假桥：取到 `876.5432`、不落 `SHAPE`、`Authorization` 占位符被正确替换、`allowCustomHost` 反证生效 |

---

## 5.1 与 core（`lib/index.js`）的调用契约

由 core 在 `2026-10-05` 明确、双方对齐（SPEC §5.2/§5.3 不变）：

* **动态 import**：`await import('./whale-registry.mjs')` / `await import('./whale-contract.mjs')`，core 用
  try/catch 包住；缺文件时插件不崩，`sync` 报 `BRIDGE_MODULES_MISSING` 且**不写盘**。
  本模块**没有顶层副作用**（只 import `node:fs/os/path`，`whale-contract.mjs` 从 registry 取一个常量），
  所以任意时刻 import 都安全。
* **`buildWhaleEntry(cfg, ctxInfo)` 的实际入参**：
  * `ctxInfo = { bridgeUrl, credentialRef, modelId, modelName, currency, matchIds, relayBaseUrl }`；
    `credentialRef` 是 core **实际解析到值**的那个候选（不一定是 `config.credentialRef`）——正因如此，
    本模块不自己猜凭据名，只用传来的 `keyRef`。
  * `cfg` = 归一化配置（SPEC §4 全 16 键）+ `balance`（normalizeBalance 结果）+ `balanceOk` +
    `unlimited` + `balanceMode`（`Number.isFinite(balance.remaining) ? 'balance' : 'events'`）。
  * 两者不一致时：`balanceMode==='events'` **必须**落成 `events`（避免「它算 events、我写成 balance」的
    静默不一致）；`balanceMode==='balance'` 但快照没有有限数值时以本模块为准并记 warning。
  * 上游失败（`balance.ok===false`）时 core **不调用、也不改写注册表**（避免条目在故障时抖动）；
    若被显式调用，本模块保持 `balance` 模式（§3.2）。
* **返回值**：`{ entry, mode, warnings }`；`entry` 保证可 `JSON.stringify`、无凭据明文。
* **注册表**：core 只在 `readWhaleRegistry(file).ok === true` 时 `upsert/remove`；
  `changed===false` **不调用** `writeWhaleRegistryAtomic`；`file = resolveWhaleApiFile(DSH_HOME || ~/.dsh)`。
* `warnings` 文案由 core 经 `redactText` 脱敏后才进 `/status`，因此本模块的警告里可以带 ref 名
  （但**不带**凭据值；本模块压根拿不到凭据值）。

---

## 5.2 spec-v2 对契约的影响（`/sync` 鉴权 + `bridgeBaseUrl` 回环限制）

> SPEC 已升到 **`spec-v2`**（新增 §10，优先级高于前文）。本节只记录**契约侧**的后果。
> 本节的实现依据已逐条读过 `lib/index.js` / `lib/newapi.mjs` 核对（见每条的「实现位置」）。
> **`lib/whale-contract.mjs` / `lib/whale-registry.mjs` 的导出签名与条目形状都没有变化** ——
> spec-v2 全是**收紧**，落在路由鉴权与地址校验上。

### 5.2.1 `POST /dsh-whale-newapi/sync` 现在与 `/balance` **共用同一个 Bearer**

| 项 | spec-v2 行为 |
|---|---|
| 鉴权方式 | `Authorization: Bearer <凭据值>`；恒定时间比较（先各自 `sha256` 再 `timingSafeEqual`，长度不同也安全、不泄漏长度差） |
| 备选形式 | `?token=<凭据值>` 同样接受（与 header 等价） |
| 比较对象 | 插件**本次实际解析到**的凭据值（与 `/balance` 用同一个 `authorize()`，同一份凭据解析结果） |
| 缺失 / 不符 | **`401`**：无凭据 → `{ok:false,code:'NO_CREDENTIAL'}`；不匹配 → `{ok:false,code:'UNAUTHORIZED'}` |
| 顺序 | 鉴权在**读 body 之前**；`enabled:false` 的 `503` 在鉴权之后（避免留下未消费的请求体） |
| 仍免 Bearer 的路由 | `/status`（只读、已脱敏、仍受回环信任栅栏保护）、`/health`（本机自检） |

实现位置：`lib/index.js` `secretEquals()`（第 170-179 行，各自 `sha256` + `timingSafeEqual`）、
`providedToken()`（第 998-1006 行，`bearerOf(req) ?? query.searchParams.get('token')`）、
`authorize()`（第 1018-1027 行）、`handleSync` 第 1130-1134 行、`handleBalance` 第 1035-1042 行。

### 5.2.2 `bridgeBaseUrl` 只允许**回环** origin

`config.bridgeBaseUrl`（配置项）与 `POST /sync` 的 `bridgeBaseUrl` 覆盖**都**必须满足：

* 协议 `http:` / `https:`；
* hostname ∈ `localhost` / `*.localhost` / `127.0.0.0/8`（逐段校验）/ `::1`（端口任意）；
* **不带 userinfo**（`https://user:pass@host/` 一律拒）；
* 沿用 `normalizeBaseUrl` 的其它限制。

两者**不合格时的处置不同**（这是 spec-v2 的关键差异）：

| 入口 | 不合格时 | 是否改写注册表 |
|---|---|---|
| `POST /sync` 的 `bridgeBaseUrl` 覆盖 | **`400`**，`{ok:false,code:'BAD_REQUEST'}` + `warnings` 写明原因（`/sync 的 bridgeBaseUrl 被拒绝（SPEC §10.2：只允许回环 origin；<原因>）`） | **不改**：整单在探测/取数/写盘**之前**返回 |
| `config.bridgeBaseUrl` | **忽略该值**（置 `''`），记 warning `bridgeBaseUrl 已被忽略并改为自动探测（SPEC §10.2：只允许回环 origin；<原因>）`，回退到自动探测 | 按回退后的地址正常同步 |
| `bridgeBaseUrl: ''`（`/sync` 覆盖） | 合法，表示「清空覆盖、回到自动探测」 | 正常 |

实现位置：`lib/newapi.mjs` `normalizeLoopbackBaseUrl()` / `explainLoopbackBaseUrl()` / `inspectLoopbackBaseUrl()`（第 178-220 行）；
`lib/index.js` `applyOverrides()` 第 722-735 行（不合格 → `hardErrors`）、`doSync()` 第 797-810 行（有 `hardErrors` 就整单拒绝、`badRequest:true`）、
`handleSync` 第 1146 行（`result.badRequest === true ? 400 : 200`）；配置项侧见 `lib/config.mjs` 第 286-290 行。

### 5.2.3 自动探测候选**允许**非回环（SPEC §10.2-a）
自动探测链 `process.env.DSH_WEB_URL` → `DSH_WEB_PORT`/`PORT` → `argv --port=<n>` **不做回环限制**：
这些值由**启动宿主的人（操作者）**控制，不在「本机任意进程改写条目 `balance.url` 把凭据导走」的威胁模型内。
但此时 `/status.warnings` **必须**出现一条非回环提示（如实告知条目 `balance.url` 将指向该主机、挂件会把凭据发往那里）。

实现位置：`lib/index.js` `resolveBridgeBaseUrl()` 第 324-333 行（命中候选后调 `explainLoopbackBaseUrl`，非回环即 push warning）；
`/status` 的 `warnings` 字段见第 1103 行。

### 5.2.4 ⚠️ 为什么这**属于契约问题**（不是单纯的插件内部安全）

条目里的 `balance.url` 就是**凭据目的地的决定者**：

1. 我们写的条目带 `allowCustomHost: true`（§2.1）。小鲸鱼 `credentialMayGoTo()`
   （宿主 `lib/index.js` **第 2084-2089 行**：`return !!(model && model.allowCustomHost === true)`）
   因此会**放行**这个自定义 origin —— 这正是我们能接自建中转站的原因，也是**风险面**：
   谁能改 `balance.url`，谁就能决定真实凭据被发到哪台机器。
2. 小鲸鱼随后在 `apiFetchJson()`（宿主 **第 2142-2163 行**）组出并发出请求头：
   第 2145-2146 行 `const a = String(auth == null ? 'Bearer {key}' : auth)` →
   `headers.Authorization = a.replace('{key}', key)`，其中 `key` 是**宿主刚从 DSH 凭据服务解析出的明文凭据**
   （`keyForDestination`，第 2101-2117 行）。也就是说：**改掉 `balance.url` == 让挂件把明文 key POST/GET 到攻击者的回环服务**。
3. 小鲸鱼官方 README《安全边界（0.3.15 起）》把这条写成了设计原则（`dsh-whale-widget` README **第 320-327 行**）：
   ① 凭据只发往厂商模板里写死的端点，自定义地址**必须**由用户在本机面板显式勾选「允许把凭据发送到自定义地址」；
   ② **配置与凭据的改动只能来自本机（回环地址）**，非回环写请求一律 `403`；
   ③ 接口地址不允许带用户名/密码。
   该 README 的规则 ② 保护的正是「改配置 == 决定凭据去向」这件事。

**结论**：`/sync` 能改写 `balance.url`，所以 `/sync` 的鉴权强度**必须与「已经持有凭据」等价** —— 这就 SPEC §10.1 要求
`/sync` 与 `/balance` 同 Bearer 的原因；同理，能落进 `balance.url` 的地址**只能**是回环（§10.2），
且**能改这个地址的入口**（`/sync`）不满足就必须**整单拒绝且一字不写注册表**（否则攻击者可先污染地址再等下一次同步）。
自动探测链是**启动者**控制的、不经 HTTP 入口的旁路，所以按 §10.2-a 只提示不拒绝。

> 一句话：`allowCustomHost:true` 是我们**主动开的门**；spec-v2 做的事就是给这扇门装锁 ——
> 开门的凭据（Bearer）与门的朝向（只能朝回环）都必须受控。

### 5.2.5 对「怎么调 `/sync`」的实际约束（跨角色）

因为 §5.2.1/§5.2.2，任何**触发同步**的调用方（运维脚本、verify、lead 的安装后验收）都必须带凭据：

```bash
# ✓ 正确：带与 /balance 相同的 Bearer（或等价的 ?token=）
curl -sS -X POST http://127.0.0.1:19387/dsh-whale-newapi/sync \
     -H "Authorization: Bearer <凭据值>" \
     -H 'Content-Type: application/json' \
     -d '{"fallbackTotal":1000}'

# ✗ spec-v1 时代的写法（无鉴权）→ 现在 401
curl -sS -X POST http://127.0.0.1:19387/dsh-whale-newapi/sync -d '{}'

# ✗ 想把 balance.url 指到非回环（例如内网另一台机器）→ 400，且注册表一字不改
curl -sS -X POST http://127.0.0.1:19387/dsh-whale-newapi/sync \
     -H "Authorization: Bearer <凭据值>" -d '{"bridgeBaseUrl":"http://192.0.2.10:19387"}'
```

`POST /sync` 只接受 4 个覆盖键（SPEC §6.3）：`bridgeBaseUrl` / `credentialRef` / `modelId` / `fallbackTotal`；
不认识的键**忽略并记 warning**（不 400）。其中 `credentialRef` 只允许 `[A-Za-z0-9_]`、`modelId` 只允许
`[A-Za-z0-9_-]`，不合格同样只忽略 + warning。

> 与条目契约的接口点：`/sync` 一旦成功，写进 `.dshw-api.json` 的 `entry.balance.url` 就等于
> `<本次生效的 bridgeBaseUrl>/dsh-whale-newapi/balance`。所以 spec-v2 的两条收紧，
> **实际效果就是给「条目里那一个字段」加了两道门禁**：改它的请求要凭据，它的值只能是回环。

---

## 6. 已知风险 / 交接注意

1. **`keyRef` 必须指向真实存在的凭据**。当前 `%USERPROFILE%\.dsh\.credentials.yaml` 的 `refs`
   只有 `PI_API_KEY`（`sk-…` 渠道 key）与 `DEEPSEEK_API_KEY`（非 sk- 的 UUID），
   **没有** `NEWAPI_RELAY_TOKEN`。`ctxInfo.credentialRef` 由 core 传入、必须来自它实际解析成功的候选
   （`credentialCandidates` 命中项），否则宿主第 2812 行会显示「未配置 …」。
   SPEC §4 的候选表含 `PI_API_KEY`，所以最坏情况下传 `PI_API_KEY` 也能工作。
2. **桥 URL 必须与 DSH Web 实际监听端口一致**（SPEC §6 的探测顺序）。
   条目写死 `bridgeBaseUrl`，端口变了要重新 sync；`Host` 必须是回环或 `DSHW_TRUSTED_HOSTS` 声明的权威，
   否则回环路由会吃到 403（第 691-728 行）。
3. **我们与宿主会并发写同一个文件**。我们的原子写只保证「每次写入是完整的」，
   不保证「宿主同时写入时我们那条一定赢」——宿主回写用的是它自己 `readApiRegistry` 的快照。
   最坏表现是下次周期同步把条目补回来（幂等），不会损坏文件。
4. **`matchIds` 是实测值，且语义是「子串」不是「等值」**（SPEC §1、宿主第 2456-2471 行）。
   中转站换模型名后，「今日已用」的会话折算会失配，需要同步更新。另外要注意
   第 2563-2564 行为「自定义单价表」额外保留了 `< 3` 字符的关键字会被忽略的规则 ——
   默认四条都 ≥3 字符（`tier-max` 等），但如果将来加短名（如 `pro`）要留意误伤；
   会话事件归属（第 2457-2471 行）**没有**这条长度限制，短名会更容易抢到别的模型。
