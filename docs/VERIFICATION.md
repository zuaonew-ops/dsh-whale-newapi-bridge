# 独立验证报告（docs/VERIFICATION.md）

> **公开版说明**：开发期验证记录存档；文中 `verify` / `core` / `bridge` / `protocol` / `lead`
> 是当时的模块角色名（验证 / 核心 / 桥接 / 协议 / 作者），不对应任何对外团队。
> 安装与使用请看 [../README.md](../README.md)、[INSTALL.md](INSTALL.md)。
> 报告中的行号与实测值属于当时的环境（2026-10-05），后续版本会漂移；`test/` 套件按内容定位核对。

* 验证角色：`verify` 子团队（**不参与实现**）。每条结论都来自本文件记录的、我自己跑出来的命令输出或我自己读过的源码。
* 判定标准：`SPEC.md` 冻结契约。本报告同时标注 **spec-v1** 与 **spec-v2（§10）** 两套结论，因为验证期间作者把 SPEC 升到了 v2。
* 环境：Windows；Node `v24.21.0`（`%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`）；DSH GUI `http://127.0.0.1:19387`；中转站 `https://relay.example.com`。
* 凭据策略：**全程不落盘、不打印**。文中一律写作 `sk-*** (长度 N)`。
* 复现命令中的 Node 路径固定为上述绝对路径（系统 `node` 可能是别的版本）。

---

## 0. 结论摘要

| 套件 | 断言 | 结果 |
|---|---|---|
| `test/verify-newapi.mjs` | 53 | **PASS** 53 / 0 |
| `test/verify-whale-registry.mjs` | 30 | **PASS** 30 / 0 |
| `test/verify-contract.mjs` | 72 | **PASS** 72 / 0 |
| `test/verify-security.mjs` | 45 | **PASS** 45 / 0 |
| `test/verify-spec-v2.mjs`（新增，§10 + §10.2-a + §10.5 边界） | 41 | **PASS** 41 / 0 |
| `test/live-e2e.mjs --no-write --live-upstream --gui` | 19 | **PASS** 19 / 0 |
| **合计（默认模式）** | **260** | **260 通过 / 0 失败** |
| `test/live-e2e.mjs --no-write --rollback-drill --gui` | 19 | **PASS** 19 / 0（额外开启 A7 只读演练断言） |
| `%TEMP%\verify-rollback-drill.mjs`（隔离目录回滚演练） | 18 | **17 通过 / 1 失败** —— 失败项 = `docs/INSTALL.md` §5 ② 的缺陷（见 §12） |

一句话结论：**A1–A7 在 spec-v2 口径下全部通过**（A7 附带一条对回滚文档的实测更正）；过程中由我独立发现 2 个真实问题：
① `/sync` 的 `bridgeBaseUrl` 可把凭据目的地改到任意外部主机（已由作者裁定并升级为 spec-v2 §10.1/§10.2，core 修复）；
② 自动探测路径也能产出非回环地址（我证伪了 SPEC 原句 → 作者裁定 §10.2-a：允许但**必须可见**，已实现并有断言）。
另发现 `docs/INSTALL.md` §5 ② 的回滚步骤**不足以移除我们的条目**（§12，实测证据）。

**但有一个必须让用户知道的操作事实（见 §9.1）**：spec-v2 的修复**已在磁盘代码里**，但**运行中的 dsh 进程仍加载着 spec-v1 的旧 bundle** —— 实测 `POST /dsh-whale-newapi/sync` 不带 `Authorization` 仍返回 `200`，带非回环 `bridgeBaseUrl` 仍返回 `200` 并生效。需要**用户重启桌面客户端**才会生效。我没有、也不会重启 dsh 进程。

另有一个用户可见的行为事实（见 §6 风险 R2）：当前账号经 sk- 渠道 key 报告**无限额度**（`hard_limit_usd=100000000`）且 `fallbackTotal=0`，因此条目落在 **`events` 模式**，挂件显示「余额 —」而**不是**面板的 credits 数字。

---

## 1. 基线与存档（回滚锚点）

| 对象 | 大小 | 时间 | SHA256 |
|---|---|---|---|
| `%USERPROFILE%\.dsh\.dshw-api.json`（**清理后 / task-4 结束时**） | 826 B | 2026-10-05 05:05:52 | `6D90C24716DA6F41DDFE9AA4FD67228A5D4FA9E90DC4C870D1B6E9B974DD9171` |
| 同上（**task-5 安装后实测时刻**，内容与上一行仅 `usage` 数值不同） | 826 B | 2026-10-05 17:31:13 | `E62846FE50865C5A3B38B5742A38A89BAE71E7B297CCC8793151C5D709161420` |
| `%USERPROFILE%\.dsh\.dshw-api.json.bak-newapi-bridge` | 604 B | 2026-10-05 04:55:27 | `55B427B5037EB3C569B974BA5E42205254EDCC4E791C1106F013CAB4E3380129` |
| 被污染态（**已清理，仅作事故存档**） | 1429 B | 2026-10-05 05:02:04 | `55FC3AE54E8D382CDC67066DB85F99358CFBF5494A1CF9F82A0246298AF77B05` |
| 清理前态（我清理脚本的输入） | 1353 B | 2026-10-05 05:05:17 | `a8f0e3bd65556baa0011b483c7c69526fe90f929b959bca9efd3b6ffe5e25ed0` |
| 作者侧安装前快照目录 | — | 目录名 `…-050239`，内含 `cordis.patch.yml`(2748 B, `7E7A3C53…`)、`package.json`(643 B, `C1D2633B…`)、`pnpm-lock.yaml`、`cordis.yml`、`.dshw-api.json`(**1429 B = 我被污染的那一版**) | `%USERPROFILE%\AppData\Local\Temp\<安装前备份> |

> ⚠️ **重要更正**：`.bak-newapi-bridge` **不是**「我们条目写入之前的干净锚点」。我 `read` 了它的全文，
> 它**本身就是一个 `newapi_relay` 条目**（`currency: CNY`、`keyRef: NEWAPI_RELAY_TOKEN`、
> `balance.url = http://127.0.0.1:19387/dsh-whale-newapi/balance`、`usage: {}`）——即插件**第一次**
> 改写注册表时留下的备份（04:55:27），那时我们的条目已经存在（更早的一轮写入）。
> 这直接影响回滚步骤的充分性，详见 §12。

注册表**是并发写的活文件**：小鲸鱼宿主会周期性回写 `usage`（`usage.*` 由宿主维护，不是我们写的）。
task-5 期间观测到它三次增长：`eventTokens` `26244376`(05:15) → `40676451`(17:31 前) → `83900286`(17:31) → 最终回归时又已变化，
`eventCost` 同步增长（字节数 826→825→826 的 1 字节差异就来自 `eventCost` 小数位数变化）。
**因此「注册表哈希不变」只能在单次实测窗口内断言**；跨命令比较必须说明是宿主所写。
下表列出实测窗口哈希：`6D90C247…`(清理后) → `E62846FE…`(§10 探测前后一致) → `CA88604C…`(最终回归前后一致，均 True)。

当前注册表内容（我亲自 `read` 过全文，41 行，中文 `name` 为合法 UTF-8）：

```json
{
  "version": 1,
  "models": [
    { "id": "newapi_relay", "name": "团队中转站", "provider": "custom", "currency": "USD",
      "keyRef": "PI_API_KEY", "baseUrl": "https://relay.example.com",
      "balance": { "url": "", "auth": "", "json": { "remaining": "" } },
      "matchIds": ["deepseek-v4.1-flash","tier-max","tier-power","tier-std"],
      "allowCustomHost": true }
  ],
  "usage": { "newapi_relay": { "day": "2026-10-05", "dayStart": null, "lastBalance": null, "delta": 0,
    "eventCost": 2.10498292, "eventTokens": 26244376, "currency": "", "tokensTotal": 26244376,
    "month": "2026-10", "tokensMonth": 26244376 } }
}
```

`usage.newapi_relay.eventTokens=26244376` 是**小鲸鱼宿主自己**写的账本，证明 `matchIds` 归属确实被消费（该数字由宿主写入，不是我验证出来的 —— 见 §5 未验证项 U5）。

---

## 2. 验收项 A1–A7（命令 → 期望 → 实际输出 → 结论）

### A1 安装可用 —— **通过**
* 命令（作者执行，我独立验证结果）：
  `plugin_manager(action:"install_bundle", target:"file:<repo>")`
  → `application: "applied"`。
* 我自己的独立证据（直连运行中进程）：
  `GET http://127.0.0.1:19387/dsh-whale-newapi/health`
  → `HTTP 200` `{"ok":true,"name":"dsh-whale-newapi-bridge","version":"0.1.0","enabled":true}`（33 ms）。
* `/status` 显示 `bridge.selfCheck={"ok":true,"httpStatus":200,"error":null}`、`internal.errors=[]`。
* 结论：**通过**（安装动作由作者完成；「插件确实在运行中的 GUI 进程里提供路由」这一点由我的直连探测独立证实）。

### A2 真实上游连通 —— **通过**
* 命令：`node test/live-e2e.mjs --no-write --live-upstream --gui`（A2 组）、`node test/verify-newapi.mjs`。
* 实际输出（真实 `/api/status`）：
  `HTTP 200 quota_per_unit=500000 usd_exchange_rate=7.3 display_in_currency=true custom_currency_symbol=credits`
  运行中进程的 `/status.upstream.relay`：`version=v1.0.0-rc.40`、`systemName="New API"`、`quotaDisplayType="CUSTOM"`、`customCurrencyExchangeRate=1`。
* compat 链路实测：`hard_limit_usd=100000000`（无限额度哨兵）→ `unlimited:true, remaining:null`；`total_usage=1966.2404 美分 → usedUsd=19.662404`。
* 结论：**通过**。

### A3 不泄漏凭据 —— **通过**
* 命令：`node test/verify-security.mjs`（含**真实凭据黑盒探测**）、`node test/verify-spec-v2.mjs`。
* 实测：
  * `/balance` 不带 `Authorization` → `401 {"ok":false,"code":"UNAUTHORIZED","error":"Bearer 凭据不匹配"}`；
  * `/balance` 带错误 `Bearer` → `401`；
  * 用真实凭据挂载实例后抓取全部路由响应体，**任何响应体里都搜不到该凭据字符串**（断言 `assertNotIncludes`，4/4 通过）；
  * `/status`、条目、注册表文件文本均不含凭据明文；
  * 运行中进程直连复查：`/balance` 无 Bearer → 401、错误 Bearer → 401，响应体无 `sk-`。
* 结论：**通过**。

### A4 四条路由契约 —— **通过（并附一条「运行中进程仍是旧代码」的警告）**
* 命令：`node test/verify-security.mjs`、`node test/verify-spec-v2.mjs`、`node test/live-e2e.mjs --no-write --live-upstream --gui`。
* 实测（磁盘代码）：
  * `/health` 无鉴权 → 200 `{ok,name,version,enabled}`；
  * `/status` 无鉴权 → 200，必需键齐全（`ok/version/config/credential/upstream/balance/whale/bridge/warnings`）+ spec-v2 允许的 `internal`；
  * `/balance` 正确 Bearer → 200；错/缺 → 401；`?token=` 亦接受；
  * `/sync`（spec-v2 §10.1）无 Bearer → **401**、错 Bearer → 401、`?token=` 正确 → 非 401；伪造 Host → **403**；未声明键被忽略且不 500；
  * 信任栅栏 13/13：`Sec-Fetch-Site: cross-site` → 403、`Host: evil.com` → 403、`Host: relay.example.com` → 403、无 Host → 403、Origin 不同源 → 403、`Origin: null` → 403；`Origin` 同 host 异端口放行；`localhost`、`127.0.0.2`、`[::1]` 均视为回环。
* 实测（**运行中的进程**，spec-v1 代码）：`POST /dsh-whale-newapi/sync` **不带** `Authorization` → **200**（见 §6 R1）。
* 结论：**通过**（以磁盘代码为准）；运行中进程的差异单独列为风险 R1，不作为未通过项。

### A5 注册表保留性（最难点） —— **通过**
* 命令：`node test/verify-whale-registry.mjs`、`node test/live-e2e.mjs --no-write --live-upstream --gui`（A5 组，对比基准 = 真实文件字节副本）。
* 实测：
  * `upsert` 后 `usage` 与其它模型**逐字段深比较**相等（含键顺序、未知顶层键）；
  * `changed===false` 时**内容哈希与 mtime 都不变**；
  * 原子写：临时文件 + `renameSync`；备份 `.bak-newapi-bridge` **已存在则不覆盖**；目标路径被目录占用时写失败且**不留 `.tmp` 残渣**；
  * 真实场景（只读隔离副本）：`其它条目 0 个逐字段保留；usage 键 1 个逐字段保留；新增 1 条`，`备份 sha256=6d90c247…` 与安装前快照**一致=true**；
  * 上一次同步 `changed=false`，注册表 mtime 未变（真实文件 05:05:52 后无写入）。
* 结论：**通过**。

### A6 小鲸鱼侧可见性 —— **通过（部分以等价离线证明替代）**
* 命令：`node test/live-e2e.mjs --no-write --live-upstream --gui`、`node test/verify-contract.mjs`。
* 实测：
  * 直连 `GET /dsh-whale/api-models.json` → **401**（无会话），**取不到**挂件视角 → 按 SPEC §8 A6 允许的方式改用**等价离线证明**；
  * 等价证明：复刻宿主真实判定链（源码行号锚点 35/35 核对通过：`L1989 pickJsonPath`、`L2000-2005 apiNum`、`L2009/L2014 mergeNonEmpty`、`L2063-2069 originOfUrl`、`L2084-2088 credentialMayGoTo`、`L2142-2163 apiFetchJson`、`L2339-2381 fetchModelBalance`、`L2709-2828 apiModelsPayload`），喂真实条目 + bridge 真实响应 → **events 模式**结论：小鲸鱼显示「余额 —」，不报 SHAPE 错误（符合 SPEC §5.2）；
  * 真实注册表里 `matchIds` 4 项齐全，且 `usage.newapi_relay` 有宿主写入的账本 → 归属生效。
* 结论：**通过**；但「挂件界面上渲染出的文字/数字」我没能亲眼看到（见 §5 U1）。

### A7 回滚可执行性 —— **通过（材料齐备；回滚本身未执行，需作者批准）**
* 命令：`node test/live-e2e.mjs --no-write --live-upstream --gui`（A7 组）、`node test/live-e2e.mjs --no-write --rollback-drill`、隔离演练脚本（见 §12）。
* 实测：快照目录 + `sha256` 已记录、回滚步骤已写明；`live-e2e.mjs` **不提供任何自动回滚开关**（`--execute-rollback` 恒为 false，我加了断言）。
* 回滚步骤（需作者明确批准；我未对真环境执行）：
  1. `plugin_manager(action:"remove_bundle", target:"dsh-whale-newapi-bridge")`
  2. **删掉 `newapi_relay` 条目**（`models` 里移除该 id、`usage` 里删同名键）。
     ⚠️ **不要**照 `docs/INSTALL.md` §5 ② 那样用 `.bak-newapi-bridge` 覆盖注册表 ——
     实测该备份**自身就含 `newapi_relay`**，覆盖后条目仍在（详见 §12 的演练证据）。
  3. 还原 profile 的 `cordis.patch.yml` / `package.json` / `pnpm-lock.yaml`（用作者快照），核对 SHA256。
* 结论：**通过**（材料齐备、演练在隔离目录完成、**文档步骤 ② 的缺陷已用实测证据指出**）。

---

## 3. spec-v2 §10 修订项的验证结果（`test/verify-spec-v2.mjs`，41/41 通过）

| 条款 | 断言要点 | 实测 | 结论 |
|---|---|---|---|
| §10.1 `/sync` 同鉴权 | 无 Bearer → 401；错 Bearer → 401；只有 `Bearer` → 401；`?token=` 错值 → 401；正确 Bearer → 非 401；`?token=` 正确 → 非 401；`/status`、`/health` 仍免鉴权 | 9/9 通过 | **通过** |
| §10.2 `bridgeBaseUrl` 仅回环 | 9 个非回环值（`evil.com`、`evil.com:10072`、`https://attacker.example`、`localhost.evil.com`、`127.0.0.1.evil.com`、`ftp://…`、带 userinfo、`[::2]`、`192.168.1.1`）→ **400 且注册表 sha256 一字不动**；`127.0.0.1`/`localhost`/`127.0.0.2`/`[::1]` → 非 400；`config.bridgeBaseUrl` 非回环被忽略 + warning + 回退后的地址仍是回环 | 12/12 通过 | **通过** |
| **§10.2-a**（作者裁定新增） | `DSH_WEB_URL=http://evil-env-probe.example:19999` → `entry.balance.url` **等于** `http://evil-env-probe.example:19999/dsh-whale-newapi/balance`、`allowCustomHost:true`；**同一场景 `/status.warnings` 必须含「非回环」且点明该 hostname**；且确实观测到对该主机的探测请求 | 3/3 通过 | **通过** |
| §10.5 边界值 | **阈值恰好 1e6 面板单位不触发**（SPEC 是严格 `>1e6`）；1e6+1 面板单位触发；`credits=0` 触发；`detail.sanityGuard={credits,panelUnits,threshold}` 只报数量级且无凭据；护栏场景 `/balance` → `200 {ok:false,code:'UNLIMITED'}` 且文案写明「触发荒诞值护栏」 | 5/5 通过 | **通过** |
| §10.3 凭据新鲜度 | 首选不可用 → 回退候选（`credential.ref=候选`，上游 Authorization 用候选值）；首选「后来出现」→ 再次 `/balance` 触发**重新解析**并切到首选（`/status.credential.ref=首选`）；同一同步轮次内条目 `keyRef` 改写为首选；首选已生效时 3 次 `/balance` 触发 `resolve` **0 次**（缓存生效） | 4/4 通过 | **通过** |
| §10.5 native 荒诞值护栏 | 正常额度不受影响（正有限值）；`quota=remain_quota=-1` → `unlimited:true, remaining:null`；`quota=0` → 同护栏；天文数字（`credits/quotaPerUnit=2e6`）→ 护栏生效、不产出天文数字；`detail.note` 写明触发原因且不含凭据；compat 分支不受护栏影响 | 7/7 通过 | **通过** |
| 隔离自检 | 真实注册表 sha256 全程未变 | 1/1 通过 | **通过** |

### 3.1 §10.2-a 的完整裁定链条（不是「把测试改绿」）

1. **我的反向用例发现事实**：SPEC §10.2 末句写「自动探测路径本身只产出回环地址，不受影响」。
   我用 `DSH_WEB_URL=http://evil-env-probe.example:19999` 实测 → `/status.bridge.baseUrl` 变成该非回环地址、
   `entry.balance.url` 指向其 `/dsh-whale-newapi/balance`、`allowCustomHost:true`，并真的探测了
   `http://evil-env-probe.example:19999/dsh-whale-newapi/health`。⇒ **该句与实现不符**（我的断言变红，保留为证据）。
2. **core 提供实现约定**：只对 `config.bridgeBaseUrl` 与 `/sync` 覆盖强制回环；env/argv 探测不校验，
   并请我以证据指出 SPEC 是否要求探测结果也回环。
3. **作者裁定**（写入 SPEC §10.2-a）：`/sync` 覆盖与 `config.bridgeBaseUrl` 是「本机任意进程都能触达」的入口，
   **保留硬约束**（我的 12/12 不动）；**自动探测候选允许非回环**（只有启动宿主的人能设置，不在威胁模型内；
   宿主端口可能只绑局域网，强行改回 `127.0.0.1` 反而取不到数）；**但必须可见**——
   选中的探测地址非回环时 `warnings` 必须明确提示「桥地址非回环 → 条目 balance.url 指向该主机、凭据会发往此地址」。
4. **实现收紧（仅可见性）**：作者亲自在 `lib/index.js` 的 `resolveBridgeBaseUrl` 里用
   `explainLoopbackBaseUrl` 判定后 push warning（`lib/index.js` 现 `SHA256=FA2F1F9F748E3D2B1CF44DE77673B3B32B6888AAD3E78D950F5172224AC0ECFD`）。
5. **SPEC 修订**：原句「自动探测路径本身只产出回环地址，不受影响」**作废**，以 §10.2-a 为准。
6. **断言更新**（3/3 通过，实测输出）：
   ```
   bridge.baseUrl=http://evil-env-probe.example:19999 internal.bridgeProbeSource=env:DSH_WEB_URL
   whale.mode=balance entry.balance.url="http://evil-env-probe.example:19999/dsh-whale-newapi/balance"
   allowCustomHost=true
   ✓ 非回环提示: 自动探测到的桥地址非回环（来源 env:DSH_WEB_URL，hostname evil-env-probe.example 不是回环地址
     （只允许 localhost/*.localhost/127.0.0.0/8/::1））：http://evil-env-probe.example:19999。
     条目 balance.url 会指向该主机，小鲸鱼会把凭据发往此地址；该候选来自宿主进程环境变量/…
   ```
   即：**行为按裁定固定下来（允许非回环）+ 强制可见性（warning 必须出现）**，而不是删掉这条用例。

---

## 4. 过程事故（如实记录，不省略）

### 4.1 我污染了真实注册表（已授权清理，已确认未复活）

**事故**：`test/verify-security.mjs` 的 `/sync` 用例最初用 `apply(ctxStub, {})` 挂**默认配置**（`autoSync:true`、`registryFile=$DSH_HOME/.dshw-api.json`），并且**没有隔离 `$DSH_HOME`**。测试体
`{credentialRef:'EVIL', modelId:'evil_id', bridgeBaseUrl:'http://evil.com', fallbackTotal:12}` 的四个键**恰好都是 SPEC §6.3 允许的键**，于是被真实应用并**写进了用户的真实文件**。

**实测证据**：文件在 2026-10-05 05:02:04 被改写为 1429 字节 / SHA `55FC3AE54E8D382CDC67066DB85F99358CFBF5494A1CF9F82A0246298AF77B05`，多出条目：

```json
{ "id": "evil_id", "name": "团队中转站", "provider": "custom", "currency": "CNY", "keyRef": "EVIL",
  "baseUrl": "https://relay.example.com",
  "balance": { "url": "http://evil.com/dsh-whale-newapi/balance", "auth": "Bearer {key}", "json": { "remaining": "remaining" } },
  "matchIds": ["deepseek-v4.1-flash","tier-max","tier-power","tier-std"], "allowCustomHost": true }
```

**① 根因修复（测试侧）**：`verify-security.mjs`、`live-e2e.mjs`、`verify-spec-v2.mjs` 现在都把
`process.env.DSH_HOME` 指向 `%TEMP%` 下的临时目录，并在末尾用 **sha256 守卫断言真实文件未被改动**。

```js
const ISOLATED_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-verify-sec-home-'))
process.env.DSH_HOME = ISOLATED_HOME   // 插件只写临时目录
```

`live-e2e.mjs --no-write` 同时补上了真隔离：把真实注册表的**字节副本**放进临时 home 再跑插件
（因为实测发现 `config.enabled=false` 时 `doSync` 仍走 `removeOurEntry()` **会写文件**，所以「不写」无法靠配置实现）。

**② 清理（作者授权后执行，用插件自己的 API）**：脚本 `%TEMP%\verify-cleanup-evil-id.mjs`
= `removeWhaleEntry(registry, 'evil_id')` + `writeWhaleRegistryAtomic(file, registry)`。

```
=== 清理前 ===  字节=1353 sha256=a8f0e3bd65556baa0011b483c7c69526fe90f929b959bca9efd3b6ffe5e25ed0
                models=["newapi_relay","evil_id"]  usage keys=["newapi_relay"]
removeWhaleEntry('evil_id') → changed=true removedEntry.id=evil_id
writeWhaleRegistryAtomic → {"ok":true,"backupPath":null,"error":""}
=== 清理后 ===  字节=826 sha256=6d90c24716da6f41ddfe9aa4fd67228a5d4fa9e90dc4c870d1b6e9b974dd9171
                models=["newapi_relay"]  usage keys=["newapi_relay"]
顶层键差异: ["models"]（期望只有 models）
usage 逐字段完全一致: true
newapi_relay 逐字段完全一致: true
evil_id 已移除: true
CLEANUP_RESULT=OK
```

* `backupPath: null` 是设计如此：`.bak-newapi-bridge` 已存在则**不覆盖**（保留 04:55:27 的干净锚点）。
* 清理后 ~90 s 复查：826 字节、SHA 仍为 `6D90C247…`、全文不含 `evil_id` 与 `evil.com` → **未复活**。
* 存档：`%TEMP%\verify-cleanup-<ts>.before.json` / `.before.meta.json` / `.after.json`。

### 4.2 我另外发现并修复的自身缺陷（不隐瞒）

| # | 缺陷 | 性质 | 修复 |
|---|---|---|---|
| 1 | `verify-helpers.mjs` 的 runner 让同步 `t.group` + 异步 `t.test` 错位打印，`finish()` 早于用例执行 | 我的测试框架 bug | `createRunner` 改为 Promise 串行链 + `pendingGroups`；组必须 `await t.group(...)` |
| 2 | `verify-security.mjs` 的 `finally` 在排队用例执行前就关掉了测试服务端 → 全部 `ECONNREFUSED` | 我的测试 bug | 组改为 `await`，服务端存活到用例结束 |
| 3 | `verify-contract.mjs` 复刻 `apiNum` 时误用严格 `Number.isFinite`（真实源码是 `Number()` 强转 + 全域 `isFinite`） | 我的复刻失真 | 改回忠实语义；对照用途另设 `strictShape` |
| 4 | 曾断言「条目配置了 `json.total/used`」→ 实际条目只有 `{remaining}` | 我的期望无依据 | 改为实测记录：**响应含 `remaining:null` 时宿主 L2375 的 `total-used` 回退不可达**（`apiNum(null)=0`，`remaining` 被置 0 而非 null），仅在**缺 `remaining` 键**时回退才可达 |
| 5 | `live-e2e.mjs --live-upstream` 里包装过的 `upstreamFetch` 调 `fetch` 时解析到自身 → `Maximum call stack size exceeded` | 我的测试 bug | 覆盖前先捕获真实 `fetch`（`const REAL_FETCH = globalThis.fetch`），包装内只用它 |
| 6 | `verify-spec-v2.mjs` 初版 compat 输入形状写错（`{subscription,usage}` → 应为 `{ok,hardLimitUsd,usedCents,usedUsd}`）、桩默认解析不到默认 `credentialRef` | 我的测试 bug | 修正形状；桩加 `anyRef`；§10.3 的 `keyRef` 断言改为先触发一个同步轮次 |

> 说明：缺陷 1–3、5、6 都曾让套件「变红」，我逐条定位为**自身测试问题**后才修，没有把它们记作实现缺陷。

---

## 5. spec-v1 缺陷证据（保留存档，不改为通过）

**发现**：spec-v1 下 `POST /sync` 既不鉴权、又原样接受 `bridgeBaseUrl` 覆盖。实测（当时的 `verify-security.mjs` 输出）：

```
本次上游请求: ["http://evil.example-verify.test/dsh-whale-newapi/health",
               "https://relay.example.com/api/status",
               "https://relay.example.com/v1/dashboard/billing/subscription",
               "https://relay.example.com/v1/dashboard/billing/usage?...",
               "https://relay.example.com/v1/models"]
实测结论: 探测了外部主机=true；条目 balance.url 指向外部主机=true；keyRef=NEWAPI_RELAY_TOKEN；allowCustomHost=true
⚠️ 风险成立：本机任意进程可经 /sync 把「小鲸鱼取余额的凭据目的地」改到任意外部主机（keyRef 不变）。
```

**危害链**：条目 `balance.url` 决定挂件把凭据发往哪里；宿主 `L2088` 因 `allowCustomHost:true` 放行该目的地、`L2146` 组装 `Authorization` 头 → 本机任意进程都能让**真实凭据**发往攻击者主机。

**处置**：作者裁定为真实缺陷 → SPEC 升级 spec-v2 §10.1（`/sync` 同鉴权）+ §10.2（`bridgeBaseUrl` 仅回环），core 已修复。

**回归断言**（现在绿）：`verify-security.mjs` 的「【spec-v2 §10.2 回归】」用例 + `verify-spec-v2.mjs` 的 12 条矩阵 —— 非回环值 → **400 且注册表 sha256 一字不动、不探测外部主机**。

---

## 6. 风险项（不是「未验证」，是「已验证但需要你决策/知情」）

* **R1（重要，操作层）**：spec-v2 修复只在磁盘代码里生效。实测**运行中的进程** `POST /dsh-whale-newapi/sync` 不带 `Authorization` → **200**（旧 bundle），且带非回环 `bridgeBaseUrl` → **200 且覆盖生效**（`bridge.baseUrl` 被改、`selfCheck.ok=false`）。**必须由用户重启桌面客户端**才会加载 spec-v2 代码。我没有重启 dsh（纪律要求）。详见 §9.1。
* **R2（重要，用户可见）**：当前 `whale.mode=events`、条目 `balance.url=""`。原因是该账号经 sk- 渠道 key 在 compat 链路报告 `hard_limit_usd=100000000`（无限额度哨兵）且 `fallbackTotal=0` → 按 SPEC §5.1.1 规则 2 无法给出数值余额，挂件显示「余额 —」。若要让挂件显示面板 credits 数字，需要：(a) 用**用户系统访问令牌（PAT）** 走 `authMode=native` 查 `/api/user/self`，或 (b) 配置 `fallbackTotal`（`remaining = fallbackTotal - 累计已用`）。安装值 `currency:'USD' + usdToCny:1` 已在运行中生效（`/status.config.currency=USD`、`balance.currency=USD`）。
* **R7（文档缺陷，建议修 `docs/INSTALL.md` §5 ②）**：文档让用户用 `.bak-newapi-bridge` 覆盖注册表来删除我们的条目，但该备份**自身已含 `newapi_relay`**（CNY 旧口径）。实测覆盖后条目仍在，且会清空宿主 `usage` 账本。正确做法是从 `models` 删除 `id==='newapi_relay'`（§12 有 18 条断言的演练证据）。
* **R8（`/sync` 有副作用，取证纪律）**：spec-v1 下 `/sync` 会接受 `bridgeBaseUrl` 覆盖并**改动运行实例的内存状态**。我取证时触发过，已复位并核对（§9.2）。任何人后续对活体实例取证都必须先评估副作用并在结束时复位。
* **R9（方法学）**：用 `fetch` **无法**伪造 `Host`（undici 丢弃受限头），我第一轮「伪造 Host → 200」是探测假象；必须用 `node:http` + `setHost:false`。真实结果是 **403**（§10 第 2/3/5 行）。
* **R3（加固建议，非缺陷）**：`Sec-Fetch-Site` 是**严格小写比较**，`Cross-Site` 变体实测放行（200）。SPEC §6 只要求拒绝小写 `cross-site`，参考实现 `dsh-better-sidebar/src/trust-fence.ts` 同样严格比较；RFC 8942 规定该头为小写 token。建议加固为 `toLowerCase()` 比较。
* **R4（口径提醒）**：该站 `/v1/dashboard/billing/usage` **忽略 `start_date/end_date`**，`total_usage` 是**累计**已用而非当月。若日后配置 `fallbackTotal`，`remaining` 是「人工额度 − 累计已用」，需要用户知情。
* **R5（已修，留档）**：测试套件曾未隔离 `$DSH_HOME` 从而写坏真实文件（§4.1）。现在五个套件都带**真实文件 sha256 守卫**，跑测试不会再动用户数据。
* **R6（`/status` 键集）**：`/status` 现含 SPEC §6.2 的 9 个键之外的 `internal`，属 spec-v2 允许（被吞异常需可见）。我的断言按「必需键必须存在」写，不断言键集恰好相等。

---

## 7. 未验证项（显式列出，不写「应该没问题」）

| # | 未验证项 | 原因 | 现有替代证据 |
|---|---|---|---|
| U1 | 小鲸鱼**界面上实际渲染出的文字/数字** | `GET /dsh-whale/api-models.json` 无会话 → **401**，我拿不到挂件视角 | 等价离线证明（复刻宿主判定链，35/35 源码锚点核对）+ 真实注册表条目被宿主消费的账本痕迹 |
| U2 | **PAT/native 分支**对真实中转站的取数 | 本机没有用户系统访问令牌（只有 sk- 渠道 key），无法真实触发 | `verify-newapi.mjs` 的 native 分支离线单测（注入 `fetchImpl`）+ `verify-spec-v2.mjs` §10.5 护栏离线断言 |
| U3 | 真实链路上的**数值型**余额（`remaining` 为有限数） | 该账号实测为 `unlimited`（`hard_limit_usd=1e8`），真实链路走不到数值分支 | 受控上游桩 + fixture 交叉核对覆盖数值分支；`verify-contract.mjs` 用真实回环 HTTP 服务端验证数值链路 |
| U4 | **回滚演练**（真的卸载/还原并核对哈希） | 需作者明确批准，脚本刻意不自动执行；且会打断用户正在使用的挂件 | A7 材料齐备 + §1 基线 SHA256 已记录 |
| U5 | 小鲸鱼宿主的记账内核行为（`usage` 各字段如何算出 `eventTokens=26244376`） | 属宿主内部实现，我只读取其产物 | 只陈述「该字段由宿主写入」这一事实，不推导其算法 |
| U6 | spec-v2 在**运行中进程**里的实际行为 | 运行中进程仍是旧 bundle（见 §9.1），我不重启 dsh | 针对磁盘代码的 41 条断言全绿 |
| U7 | `internal.schemaSource="bare:@deepseek-ai/schemastery"` 的确切含义 | 属宿主 Loader 行为，未在本次范围内 | 原样记录，不做解释 |
| U8 | 用户重启后 spec-v2 是否真的在宿主进程里生效 | **需要用户重启桌面客户端**；重启后 `/sync` 无 Bearer 应变成 401、`/sync` 带非回环 `bridgeBaseUrl` 应变 400 | 磁盘代码 41/41 + 磁盘 SHA256 与工作区一致；重启后请复跑 §8 的两条直连探测 |

---

## 8. 复现命令清单

```powershell
$node = '%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
$pkg  = '<repo>'

# 离线套件（全部自带 $DSH_HOME 隔离 + 真实文件 sha256 守卫；不联网）
& $node "$pkg\test\verify-newapi.mjs"          # 53/0
& $node "$pkg\test\verify-whale-registry.mjs"  # 30/0
& $node "$pkg\test\verify-contract.mjs"        # 72/0
& $node "$pkg\test\verify-security.mjs"        # 45/0
& $node "$pkg\test\verify-spec-v2.mjs"         # 41/0（SPEC §10 + §10.2-a + §10.5 边界）
& $node "$pkg\test\verify-credential-refresh.mjs"  # 25/0（task-9/task-10：凭据值替换必须生效；含 warnings 陈旧残留复现，见 §14/§15）

# 端到端（只读隔离 + 真实上游 + GUI 探测；真实注册表零改动）
& $node "$pkg\test\live-e2e.mjs" --no-write --live-upstream --gui   # 19/0
& $node "$pkg\test\live-e2e.mjs" --no-write --rollback-drill --gui  # 19/0（额外跑 A7 只读演练断言）

# 运行中进程的直连复核（只读 HTTP，不重启任何进程）
#   GET  http://127.0.0.1:19387/dsh-whale-newapi/health
#   GET  http://127.0.0.1:19387/dsh-whale-newapi/status
#   GET  http://127.0.0.1:19387/dsh-whale-newapi/balance        （无 Bearer → 401）
#   POST http://127.0.0.1:19387/dsh-whale-newapi/sync           （旧 bundle：无 Bearer → 200，见 §9.1）
```

写入范围（仅本子团队）：`test/verify-*.mjs`、`test/live-e2e.mjs`、`docs/VERIFICATION.md`。
未改动任何实现文件、未改动 `SPEC.md`、未重启/杀死任何进程、未打印任何凭据明文。

---
---

# 附录：task-5「安装后实测」（真环境取证）

## 9. 部署状态：**磁盘是 spec-v2，运行中的进程仍是 spec-v1**

| 层面 | 状态 | 证据 |
|---|---|---|
| 磁盘代码（安装副本 + 工作区） | **spec-v2**（含 §10.2-a） | **7 个文件逐字节一致**，见下表 |
| 运行中的宿主进程 | **spec-v1**（ESM 模块缓存，需重启宿主才换代码） | 见 §9.1 三条实测 |
| profile 配置（作者写入并热生效） | `currency: USD`、`usdToCny: 1`、`authMode: auto`、`autoSync: true`、`syncIntervalSeconds: 300`、`modelId: newapi_relay` | `/status.config` 原样回读，见 §10 |

### 9.0 安装副本 vs 工作区（我自己算的 SHA256，逐文件比对）

安装路径 `%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-whale-newapi-bridge`，
`LinkType` 为空 ⇒ **真目录复制**（不是符号链接/联接），所以工作区改动**不会**自动同步到安装副本 —— 必须重装。

| 文件 | 工作区 SHA16 | 安装副本 SHA16 | 一致 |
|---|---|---|---|
| `lib/index.js` | `FA2F1F9F748E3D2B` | `FA2F1F9F748E3D2B` | **一致** |
| `lib/newapi.mjs` | `B255845EF4A5C363` | `B255845EF4A5C363` | **一致** |
| `lib/config.mjs` | `B3A3FC37B7D5B1DA` | `B3A3FC37B7D5B1DA` | **一致** |
| `lib/whale-registry.mjs` | `63169962A211CB70` | `63169962A211CB70` | **一致** |
| `lib/whale-contract.mjs` | `9A64D6EAB7E97CB0` | `9A64D6EAB7E97CB0` | **一致** |
| `package.json` | `5B7D0E6455D9CBE8` | `5B7D0E6455D9CBE8` | **一致** |
| `cordis.patch.yml` | `38A8307D07E4C3D8` | `38A8307D07E4C3D8` | **一致** |

并且安装副本 `lib/index.js` **确实含** §10.2-a 的非回环告警（L329：
`` `自动探测到的桥地址非回环（来源 ${candidate.source}，${notLoopback}）：${candidate.baseUrl}。` ``）⇒
**用户重启后 §10.2-a 的可见性保证会生效**（当前不生效只因为进程还跑着旧模块）。

`SPEC.md` 不在安装副本里（`(缺失)`），符合预期（bundle 不需要 SPEC）。

### 9.1 运行进程仍是 spec-v1 的实测证据（三条）

```
POST /dsh-whale-newapi/sync                         [无 Authorization] → HTTP 200   （spec-v2 §10.1 要求 401）
POST /dsh-whale-newapi/sync {bridgeBaseUrl:'http://evil-verify.example'}            → HTTP 200
  随后 GET /status  → bridge.baseUrl = http://evil-verify.example
                      internal.bridgeProbeSource = config.bridgeBaseUrl
                      bridge.selfCheck = {ok:false, error:"网络错误：fetch failed"}
                      warnings = ["桥自检未通过：GET /dsh-whale-newapi/health @ http://evil-verify.example → 网络错误：fetch failed"]
                      （spec-v2 §10.2 要求 400 且不改动任何内部状态）
```

即：**运行中的实例可以被本机任意进程用 `/sync` 改掉桥地址**（这正是 spec-v1 的缺陷形态）。
我**没有**重启宿主；此项待用户重启后复查（§7 U8）。

### 9.2 我探测过程中对活体状态的扰动与复位（如实记录）

我上面那条「覆盖被接受」的探测**确实改了运行中进程的内存状态**（`bridge.baseUrl` 被指向不存在的主机，
`selfCheck.ok` 变成 `false`）。这是我自己造成的扰动，已**复位并核对**：

```
POST /sync {bridgeBaseUrl:'http://127.0.0.1:19387'}  → HTTP 200
复位后 bridge.baseUrl = http://127.0.0.1:19387
复位后 internal.bridgeProbeSource = config.bridgeBaseUrl
复位后 selfCheck = {"ok":true,"httpStatus":200,"error":null}
复位成功 = true
```

教训：`/sync` 是**有副作用**的端点，spec-v1 下它会接受覆盖；对运行实例做取证必须先想清楚副作用并复位。

## 10. 安装后实测表（命令 → 实际输出 → 结论）

探测方式：`node:http` 直连运行中实例（`%TEMP%\verify-postinstall2.mjs`）。
**关键方法学修正**：伪造 `Host` **不能**用 `fetch` —— undici 把 `Host` 当受限头丢弃，
我第一次的「伪造 Host → 200」是**探测自身的假象**。改用 `node:http` + `setHost:false` 后才是真的伪造。

| # | 命令 | 期望 | 实际输出 | 结论 |
|---|---|---|---|---|
| 1 | `GET /dsh-whale-newapi/health` | 200 | `200 {"ok":true,"name":"dsh-whale-newapi-bridge","version":"0.1.0","enabled":true}` | **通过** |
| 2 | `GET /health`，`Host: evil.com` | 403 | `403 {"ok":false,"code":"FORBIDDEN","error":"请求未通过回环信任栅栏"}` | **通过** |
| 3 | `GET /health`，`Host: relay.example.com` | 403 | `403 {"ok":false,"code":"FORBIDDEN",…}` | **通过** |
| 4 | `GET /dsh-whale-newapi/status` | 200，必需键齐全 | `200`，顶层键 `["ok","version","config","credential","upstream","balance","whale","bridge","warnings","internal"]`，`internal.errors=[]` | **通过** |
| 5 | `GET /status`，`Host: evil.com` | 403 | `403 FORBIDDEN` | **通过** |
| 6 | `GET /dsh-whale-newapi/balance`（无 Bearer） | 401 | `401 {"ok":false,"code":"UNAUTHORIZED","error":"Bearer 凭据不匹配"}` | **通过** |
| 7 | `GET /balance`（错误 Bearer） | 401 | 同上 | **通过** |
| 8 | `GET /balance`（**真实凭据**，输出脱敏 `sk-*** (长度 51)`） | 200 | `200 {"ok":false,"code":"UNLIMITED","error":"无限额度：上游未提供数值余额，且未配置 fallbackTotal（条目已降级为 events 模式）"}` | **通过**（语义正确：unlimited 而非假造数字） |
| 9 | `POST /dsh-whale-newapi/sync`（无 Bearer） | spec-v2: 401 | **200** `{"ok":true,"changed":false,"mode":"events",…}` | **未通过（运行进程）** = spec-v1 代码，见 §9.1；磁盘代码已 401 |
| 10 | `POST /sync`（真实 Bearer） | 200 | `200 {"ok":true,"changed":false,"mode":"events","entry":{…"currency":"USD","keyRef":"PI_API_KEY"…}}` | **通过** |
| 11 | `POST /sync {bridgeBaseUrl:'http://evil-verify.example'}` | spec-v2: 400 | **200 且覆盖生效** | **未通过（运行进程）** = spec-v1 缺陷形态，见 §9.1 |
| 12 | `GET /dsh-whale/api-models.json` | 401（无会话） | `401`（空体） | **无法验证**（拿不到挂件视角 → 用等价离线证明，见 §11） |
| 13 | `POST /balance` | 405 | `405 {"ok":false,"code":"METHOD","error":"只支持 GET"}` | **通过** |
| 14 | `GET /dsh-whale-newapi/nope` | 404 | `404` | **通过** |

**注册表前后（§10 表全部探测期间）**

```
前: 826 B  sha256=e62846fe50865c5a3b38b5742a38a89bae71e7b297ccc8793151c5d709161420  mtime=2026-10-05T09:31:13Z
后: 826 B  sha256=e62846fe50865c5a3b38b5742a38a89bae71e7b297ccc8793151c5d709161420  mtime=2026-10-05T09:31:13Z
sha256 相同: true
usage 前/后: {"day":"2026-10-05","eventCost":5.78303912,"eventTokens":83900286,"tokensTotal":83900286,"month":"2026-10","tokensMonth":83900286}（两次一致）
models=["newapi_relay"] 顶层键=["version","models","usage"]
```

（`usage` 的跨时段增长见 §1 的说明：那是**小鲸鱼宿主**周期性回写，不是我们写的。）

## 11. A5 保留性（用真实文件，诚实结论）

* 真实 `.dshw-api.json` 的 `models` 只有 **1** 条：`["newapi_relay"]`；顶层键只有 `["version","models","usage"]`。
* `usage` 只有 1 个键 `newapi_relay`（宿主账本），我们**只是保留**它、从不改写它。
* **本机注册表原本没有其它自定义模型** —— 所以「保留性」在这里的含义是：
  **没有覆盖/丢失任何既有内容，且新增了恰好 1 条**，而不是「保住了 N 条别的模型」。
  这条我是对着作者快照里的 `.dshw-api.json`（1429 B / `55FC3AE5…`）与当前文件逐字段比对的结论。
* 我们条目的字段逐个核对（`id/name/provider/currency/keyRef/baseUrl/balance/matchIds/allowCustomHost`）
  与 `lib/whale-contract.mjs` 的 `buildWhaleEntry` 期望一致，详见 §2 A5 与 `test/verify-contract.mjs`（72/72）。
* ⚠️ 需要作者知情：`.bak-newapi-bridge` **本身已含 `newapi_relay`**（§1 更正），所以它**不能**当作
  「安装前的注册表」，也不能作为回滚恢复源（§12 有实测）。

## 12. A7 回滚演练（**全部在 `%TEMP%` 隔离目录完成，真 profile 一字未改**）

演练脚本 `%TEMP%\verify-rollback-drill.mjs`，演练目录 `%TEMP%\verify-rollback-drill-<ts>\`
（`snapshot/` = 作者快照副本，`work/` = 模拟现场）。**18 条断言：通过 17 / 失败 1**，失败的正是文档步骤。

```
=== 3. §5 ① 模拟 remove_bundle ===
  ✓ 依赖已移除          ✓ bundles 项已移除        ✓ 其它依赖仍在（4 个）
=== 4. §5 ③ 恢复 profile 配置（用作者快照）===
  ✓ work/cordis.patch.yml SHA256 == 作者快照 — work=7e7a3c534468eb04 快照=7e7a3c534468eb04
  ✓ work/package.json     SHA256 == 作者快照 — work=c1d2633b88b40851 快照=c1d2633b88b40851
  ✓ work/pnpm-lock.yaml   SHA256 == 作者快照 — work=666753fbb3ad94f5 快照=666753fbb3ad94f5
  ✓ 恢复后的 cordis.patch.yml 不含我们的配置块
  ✓ 恢复后的 package.json 不含依赖/bundles 项
=== 5. §5 ② 按文档原样：Copy-Item .bak-newapi-bridge → .dshw-api.json ===
  恢复后 models = ["newapi_relay"]      ← 条目还在！
  恢复后 usage 键 = []
  ✗ 【文档步骤 ② 的充分性】恢复 .bak 后 newapi_relay 应已消失 — 实测 models=["newapi_relay"]
=== 6. 修正做法：直接删除我们的 id 条目 ===
  ✓ 删除后 models 为空 []    ✓ 删除后无 newapi_relay    ✓ 删除后 usage 不含 newapi_relay
=== 7. 真环境完整性（演练不得改动真文件）===
  ✓ 真 profile/cordis.patch.yml 未被改动   ✓ 真 profile/package.json 未被改动
  ✓ 真 profile/pnpm-lock.yaml 未被改动     ✓ 真 profile/cordis.yml 未被改动
  ✓ 真注册表未被演练改动                    ✓ 真 .bak-newapi-bridge 未被改动
```

**发现（对 `docs/INSTALL.md` §5 ② 的缺陷）**：文档让用户用 `.bak-newapi-bridge` 覆盖注册表来「删掉我们写进小鲸鱼的条目」，
但该备份**自身就是一个 `newapi_relay` 条目**（`currency: CNY`、`balance.url` 指向 bridge、`usage: {}`），
覆盖后条目**依然存在**，而且会把条目退回旧口径（CNY + balance.url 有值）并**清空宿主账本**。
**正确做法**：从 `models` 里删除 `id === 'newapi_relay'` 的元素（并按需删除 `usage.newapi_relay`），
即演练 §6 的做法（实测条目确实消失，`models` 变空数组）。

**回滚演练结论**：`通过`（材料齐备、步骤可在隔离环境完整执行、profile 侧恢复能精确回到快照 SHA256、
注册表侧用「删条目」能真正清除）；但**文档 §5 ② 需按上述修正**。
真环境侧我**未执行**任何回滚（`plugin_manager remove_bundle` 属作者动作，且会打断用户挂件）。

## 13. 小鲸鱼侧（A6）在真实环境的补充事实

* `GET /dsh-whale/api-models.json` → **401**（无会话）⇒ 本机无会话情况下**取不到小鲸鱼视角**，明确记录。
* 替代证明：复刻宿主 `fetchModelBalance` 判定链（35/35 源码锚点核对）喂真实条目 + bridge 真实响应
  → **events 模式 ⇒ 挂件显示「余额 —」，不报 SHAPE 错误**（符合 SPEC §5.2）。
* 真实注册表侧的事实：`matchIds` 4 项齐全（`deepseek-v4.1-flash`、`tier-max`、`tier-power`、`tier-std`），
  且宿主已写 `usage.newapi_relay`（`eventTokens` 从 26244376 增长到 83900286）⇒ **条目确实被宿主消费**。
* 未能亲眼看到界面渲染结果（§7 U1）。

---

## 14. 真机事故：凭据值替换不生效 → 缓存作废（task-10，独立验证）

> 本节全部结论来自**我自己运行**的命令与**我自己读取**的源码/报文；不引用他人转述。
> 新套件：`test/verify-credential-refresh.mjs`（25 断言全绿），实现 SHA256
> `lib/index.js = 08B8CEE46694DC03ABCB9CD611DBDFD57704EE47FE45099CCAA5C7596D095670`（core 的 task-9 交付）。

### 14.1 现象（用户视角）

用户把 `refs.NEWAPI_RELAY_TOKEN` 填成占位符（`<n…=>`，len 34）→ 中转站 `/api/user/self` 返回 401；
**之后用户把该值改成正确令牌，插件行为不变**（挂件仍取不到数值余额），只有重启宿主才可能生效。
根因不是"值没保存"，而是**插件把已解析到的凭据值缓存在内存里**，改值后下一次操作仍用旧值。

### 14.2 证据

**(1) 上游 401 报文（我用自己的假令牌独立复现，不使用用户真实值）**

```
GET https://relay.example.com/api/user/self   Authorization: Bearer sk-bogus-task10-not-real
→ HTTP 401  {"code":"AUTH_UNAUTHORIZED","message":"Unauthorized, invalid access token","success":false}
对照 GET /api/status（公开端点）→ HTTP 200
```

**(2) 活体 `/status`（只读 HTTP，2026-10-05 20:49 本地）——修复生效后的正确状态**

```
credential      = {"ref":"NEWAPI_RELAY_TOKEN","present":true,"source":"config"}
upstream.auth   = {"requestedMode":"auto","usedMode":"native","credentialRef":"NEWAPI_RELAY_TOKEN",
                   "credentialSource":"config","attempts":[{"mode":"native","ok":true,"code":null,"httpStatus":200,"withUserHeader":false}]}
whale           = mode=balance  entry.keyRef=NEWAPI_RELAY_TOKEN
                  entry.balance.url="http://127.0.0.1:19387/dsh-whale-newapi/balance"
balance         = {ok:true,source:"native",remaining:41.295544,total:65,used:23.704456,currency:"USD",unlimited:false}
bridge.selfCheck= {ok:true,httpStatus:200,error:null}
internal.errors = []
```

**(3) 事故期间 `/status` 的失败形态**：`upstream.auth.attempts` 为 `native` 与 `compat` **两条都 HTTP 401**，
`balance.ok=false`、`balance.code=HTTP_401`；`internal.errors=[]`（取数失败走 `ok:false` 形状，不是异常）。

**(4) 运行中进程仍是 task-9 之前的代码**（与 §9.1 一致，需用户重启）：
`/status.internal` 的键是
`["startedAt","schemaSource","credentialCandidatesTried","bridgeProbeSource","lastSyncTrigger","syncIntervalSeconds","autoSync","errors"]`
—— **没有** `credentialResolveCalls` / `credentialCacheHits` / `credentialInvalidations` / `credentialCacheInvalidatedAt`
（这四项我实测均为 `undefined`）。所以真机现在的"能用了"是作者用 `{"credentialRef":"NEWAPI_RELAY_TOKEN"}` 覆盖
**强制重解析**得到的，不是 task-9 的自动作废路径；task-9 的行为只能在磁盘代码上离线验证（本套件做的就是这个）。

### 14.3 根因：与宿主 `credentials` 服务契约冲突

契约原文由我从 `D:\ai hook\deepseekharness\resources\app.asar` **第 1014486 行**提取（rg 定位 + 读取）：

```
abstract resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined>
description: 'Resolve one reference to its current value. Resolution is per call: consumers
  re-resolve at each operation and must not cache across operations — that per-operation read
  is what makes a changed credential reach the next operation without a restart.'
```

而修复前的 `lib/index.js`：`resolveCredential()`（L462 起）只要 `credentialCache !== null && credentialValue !== null`
就直接返回缓存（L463-466），仅在 `credentialNeedsRefresh()`（L451-452：缓存到的 ref ≠ `config.credentialRef`）时
才重新解析。**同 ref 名下值被替换这一最常见情形完全没有重解析路径** —— 改成正确令牌后，缓存里还是占位符。

### 14.4 修复（core 的 task-9，我只验证不改）

* 新增 `isAuthFailureOnly(attempts)`（L528-533）：attempts **非空**且每条都是 `HTTP_401`/`HTTP_403`；
  `attempts.length === 0` 显式返回 false ⇒ **`NO_CREDENTIAL` 不会被误判**（`[].every()` 天然为 true 的坑被堵住）。
* `refreshBalance()`（L639-648）：`upstream.chosen === null && isAuthFailureOnly(upstream.attempts)` 时
  `credentialValue = null; credentialCache = null;` + `credentialInvalidations += 1` + `credentialCacheInvalidatedAt = Date.now()`
  + 一条 warning（只含 ref 名，不含值）。**成功路径行为不变**（仍有缓存）。
* `/status.internal` 新增四个纯数字/时间戳诊断项（L1147-1150）。

### 14.5 我独立跑出的断言输出（`test/verify-credential-refresh.mjs`，25/25 PASS）

```
PASS  b 成功路径仍缓存：上游 200 时连续操作 → resolve 不再增加（必须保持绿）  (4/4)
PASS  a 真机事故复现：值被替换后必须生效（鉴权失败 → 缓存作废）  (7/7)
PASS  反向：非鉴权失败（500）不得被误判为凭据失效  (2/2)
PASS  d 对抗性边界：单模式/混合/部分失败/无凭据  (5/5)
PASS  e warnings 陈旧残留：失败一轮后成功，失败文案是否还在  (5/5)
PASS  守卫  (2/2)
----- 合计: 25 通过 / 0 失败 (25 项) -----
```

与 task-10 三条要求的对应关系：

| 要求 | 断言 | 实测 |
|---|---|---|
| **a. 值被替换能生效** | a3 / a5 / a6 / d5 | 改成 B 后**下一次** `/sync` 就 200；上游收到的凭据 `["Bearer VERIFY-CORRECTED-TOKEN-B-0002"]`；旧值 A 不再发往上游；`/status.credential.ref` 始终是 `NEWAPI_RELAY_TOKEN` |
| **b. 成功路径仍缓存** | b1 / b2 / b3 | `internal.credentialResolveCalls` 首次操作后 = **1**；随后 3×`/sync` + 3×`/balance` 的 resolve 增量 = **0**，且这 3 次 `/sync` 确实都打了上游（`credentialCacheHits` 增长）——缓存没有被 task-9 破坏 |
| **c. internal 可观察痕迹** | a2 | 401 轮后 `credentialInvalidations=2`、`credentialCacheInvalidatedAt=1791204549546`（有限数）；措辞字段名与 core 实现一致：`credentialResolveCalls` / `credentialCacheHits` / `credentialInvalidations` / `credentialCacheInvalidatedAt` |

其它关键实测行（全部来自我的运行输出）：

```
改值后第 1 次操作：HTTP 200；上游收到=["Bearer VERIFY-CORRECTED-TOKEN-B-0002"]；balance.source=native   ← 同一次操作即生效
上游仍 401：2 次 /sync 的 resolve 增量=2（期望 ≥2）；credentialInvalidations=5                          ← 持续失败期不吞掉改值
填入 B 后：/sync HTTP 200；上游收到=["Bearer VERIFY-CORRECTED-TOKEN-B-0002"]                              ← 从"无凭据"填上值也立即生效
500 场景：credentialInvalidations 0 → 0（期望 0 → 0）；后续 resolve 增量=0                                ← 非鉴权失败不误伤缓存
authMode=native 全 401 → credentialInvalidations=2                                                        ← d1 单模式
native=401 + compat=403 → credentialInvalidations=2                                                       ← d2 混合
compat 成功（source=compat）→ credentialInvalidations=0（期望 0）；resolve 增量=0                          ← d3 部分失败不得作废
无凭据：credential.present=false；credentialInvalidations=0（期望 0）                                      ← d4 NO_CREDENTIAL 不误判
```

**结论：通过。** 值替换能生效（且在同一次后续操作生效）、成功路径缓存未被破坏、非鉴权失败不误伤、
无凭据不误判；`internal` 有可观察、无凭据明文泄漏的作废痕迹。

### 14.6 事故期间真实 `.dshw-api.json` 只读核对（任务第 3 条）

| 时点 | 字节 | sha256 | `models` | `keyRef` | `balance.url` |
|---|---|---|---|---|---|
| **事故窗口**（20:43:02 本地，用户改值+401 期间） | 829 | `3ABD79E8E1D8CFD44FF4D84406234F8C15E120B2FE84D4170EE0C6EDC8780D07` | `["newapi_relay"]` | `PI_API_KEY` | `""` |
| 凭据修好之后（20:49:58 本地） | 922 | `fe5c9659dd14f1e754ac35c273ff91822be64f6709f0f395150aa271f592d1d2` | `["newapi_relay"]` | `NEWAPI_RELAY_TOKEN` | `http://127.0.0.1:19387/dsh-whale-newapi/balance` |

* **事故期间条目未被改写**：仍是候选回退口径（`keyRef=PI_API_KEY`、`balance.url=""`），
  `usage.newapi_relay = {day:"2026-10-05",dayStart:null,lastBalance:null,delta:0,eventCost:7.10667808,
  eventTokens:104592531,currency:"",tokensTotal:104592531,month:"2026-10",tokensMonth:104592531}`。
  ⇒ 事故**没有把坏状态写进用户数据**；`models` 全程只有 `newapi_relay` 一条，没有污染。
* 凭据生效后（第二行）插件**按预期**把条目重写成 balance 模式（`keyRef` 随解析到的 ref 更新、`balance.url` 指向 bridge），
  这是**正确**的写入，不是事故残留。
* `usage` 各字段是**小鲸鱼宿主**持续回写的账本：我两次读取之间 `eventTokens` 从 `104592531` 涨到 `108994597`，
  `dayStart/lastBalance/delta` 也开始有值（宿主按余额差记账）。**我们不写 `usage`**，所以"哈希未变"只在单次测量窗口内成立。
* `.bak-newapi-bridge` 我全程未动：sha256 `55B427B5037EB3C569B974BA5E42205254EDCC4E791C1106F013CAB4E3380129`（≠ 干净的安装前注册表，见 §11/§12）。
* 本套件自带**真实注册表 sha256 守卫**，25 条断言跑完后真实文件未被我改动。

---

## 15. 裁定：成功周期后 `/status.warnings` 仍残留 401 文案 → **① 累积型陈旧残留（缺陷，低危）**

**作者提出的疑点**：一次**完全成功**的同步后（`balance.ok=true`、`upstream.auth.attempts` 全 `native:true`、`usedMode=native`），
`/status.warnings` 里仍留着 `上游取数失败（HTTP_401）… invalid access token`。是①陈旧残留还是②本周期"先 401 再重试成功"的有意记录？

### 15.1 裁定：**① 累积型陈旧残留**（不是 task-9 的有意记录）

**源码依据（`lib/index.js`，SHA16 `08B8CEE4…`）**

* **L396-401 `pushWarning()`：只去重 + 封顶（`warnings.length > MAX_WARNINGS(50)` 时 `shift()`），
  成功时从不清空、也没有"本轮"概念** —— 这是残留的结构性原因。
* **L1014**（`runSync` 收尾）：`for (const warning of result.warnings) pushWarning(warning)` ——
  把**每轮同步的局部 warnings**（包括失败轮 L868 的 `上游取数失败（HTTP_401）：…；本次不改写注册表`）
  推进**持久** `warnings`。所以失败轮一过，这条文案就永久留在 `/status.warnings`。
* **L867-868**：该文案只在 `balance.ok !== true` 时生成，属**失败轮**的产物。
* **L644-647** 是 task-9 **另一条措辞**：`上游鉴权失败（所有 authMode 均 HTTP_401/403）：已作废凭据缓存…`。
  两者文本完全不同，可区分。
* **决定性反证**：真机运行进程的 `internal` 里**没有** `credentialInvalidations`（实测 `undefined`）⇒ 它跑的是
  task-9 **之前**的代码，L644 那条根本没执行；而真机 warnings 里出现的正是 **L868 的文案**（逐字匹配）。

### 15.2 可复现实测（本套件 e 组，5/5）

```
对照组 e1（从开始就成功）：成功路径 warnings（2 条）中含「上游取数失败」的条数=0（期望 0）
e2（失败一轮）           ：/status.warnings 出现 [1] 上游取数失败（HTTP_401）：…；本次不改写注册表
                              [2] /v1/models 取模型列表失败（HTTP_401），matchIds 使用兜底列表
e3（随后一轮完全成功）    ：balance.ok=true  mode=native
   ⇒ 成功周期后：陈旧「上游取数失败」=1 条；task-9「已作废凭据缓存」=1 条
```

**真机同现象（只读 HTTP，20:49）**：`balance.ok=true`、`usedMode=native`、`internal.errors=[]`，
而 `/status.warnings` 仍为

```
[0] authMode=auto：sk- 渠道 key 会先走 compat（billing），其它令牌先走 native（/api/user/self）
[1] 上游取数失败（HTTP_401）：上游返回 HTTP 401：{"code":"AUTH_UNAUTHORIZED","message":"Unauthorized, invalid access token","succ；本次不改写注册表
[2] /v1/models 取模型列表失败（HTTP_401），matchIds 使用兜底列表
```

`[1]`/`[2]` 都是**事故那一轮**留下的（`[1]` 是 L868、`[2]` 是 models 兜底提示），与当前成功状态无关。

### 15.3 定级与建议（**我不改实现，交作者与 core 决定**）

* **定级：缺陷，低危。** 不影响取数/记账/挂件显示，但**会直接误导排障**：用户看到"上游 401"会以为凭据还是错的，
  而此时 `balance.ok=true`。task-9 新增的 `已作废凭据缓存` 文案**也**是同样机制下的持久条目（成功轮后仍在）。
* 可选修法（三选一，供作者/core 取舍）：① 成功轮清掉**瞬时型**上游失败 warning（保留 `authMode=auto` 这类配置说明）；
  ② 给 warnings 加轮次/时间戳，`/status` 里区分"本轮"与"历史"；③ 只保留最后 N 条并附 `at`。
* 反向提醒：**不要**把 warnings 做成"只报当前轮"而丢掉历史审计价值；建议拆成 `warnings`（本轮）+ `history`。
* 需要重启宿主才可见（真机当前仍是 task-9 之前的进程，§14.2(4)）。

