// dsh-whale-newapi-bridge — 小鲸鱼条目契约
//
// 职责：把插件侧的余额快照翻译成小鲸鱼宿主能消费的 `.dshw-api.json` 模型条目（SPEC §5.2）。
//
// 冻结契约：SPEC.md `spec-v1` §5.2；余额形状 §5.1.1。
// 小鲸鱼宿主事实来源：dsh-whale-widget@0.3.18 · lib/index.js
//   · credentialMayGoTo      第 2084-2089 行  → 自定义 origin 必须 allowCustomHost === true 才带凭据
//   · templateOrigins        第 2070-2082 行  → 不含 {base} 的模板端点才算「内置可信」
//   · keyForDestination      第 2101-2118 行  → 无凭据时 entry.error = '未配置 <keyRef>'
//   · mergeNonEmpty          第 2009-2019 行  → 模型条目的空串**不覆盖**模板默认值
//   · apiFetchJson           第 2142-2163 行  → GET + `Authorization: <auth>`.replace('{key}', key)
//   · fetchModelBalance      第 2339-2381 行  → b.url.replace('{base}', base)；json.remaining 取值；
//                                               remaining===null 且 total!==null → total-used；
//                                               仍为 null → code 'SHAPE'
//   · apiModelsPayload       第 2744-2826 行  → entry.balanceMode / hasBalanceApi / needsHostConfirm
//
// 一句话：条目就是我们与小鲸鱼之间**唯一**的接口，改小鲸鱼源码会随 npm 升级被覆盖
// （见 docs/WHALE-CONTRACT.md「为什么不改小鲸鱼源码」）。

import { WHALE_API_FILENAME } from './whale-registry.mjs'

/** 注册表文件名（SPEC §5.2）。 */
export const WHALE_API_FILE = WHALE_API_FILENAME

/** SPEC §5.2：默认条目 id。 */
export const DEFAULT_WHALE_MODEL_ID = 'newapi_relay'

/** SPEC §5.2：默认显示名。 */
export const DEFAULT_WHALE_MODEL_NAME = '团队中转站'

/** 本机中转站 `/v1/models` 实测值（SPEC §1）；用它们把会话里的模型名对到我们这条条目上。 */
export const DEFAULT_MATCH_IDS = Object.freeze([
  'deepseek-v4.1-flash',
  'tier-max',
  'tier-power',
  'tier-std',
])

/** 我们的余额路由（SPEC §6.1）。 */
export const BALANCE_ROUTE_PATH = '/dsh-whale-newapi/balance'

/**
 * 小鲸鱼取值表达式：`json.remaining === 'remaining'`。
 * 含义是「在响应体顶层取 `remaining`」——见 pickJsonPath（第 1989-1999 行）与
 * fetchModelBalance 第 2362 行。我们路由的响应体顶层就有 `remaining`（SPEC §6.1）。
 */
export const BALANCE_JSON_PATH = 'remaining'

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function str(v) {
  return String(v == null ? '' : v).trim()
}

function finiteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v)
}

/**
 * 防御性校验 SPEC §5.1.1 的 normalizeBalance 输出，判定能否走 `mode:'balance'`。
 *
 * 只有「有限数值 remaining」才允许 balance：小鲸鱼对 `remaining === null` 会直接报
 * code `SHAPE`（第 2375-2376 行），那会在挂件里显示一行红色错误而不是余额。
 *
 * @returns {{ok:boolean, reason:string, remaining:number|null}}
 */
function surveyBalance(coverage) {
  if (!isPlainObject(coverage)) {
    return { ok: false, failed: false, reason: '没有余额快照（coverage 缺失）', remaining: null }
  }
  const failed = coverage.ok === false
  const remaining = coverage.remaining
  // ⚠️ 判定顺序至关重要：**先看有没有可下发的有限数值**，再看 unlimited。
  //    `unlimited === true` 本身**不是**降级条件 —— SPEC §4 `fallbackTotal`：
  //    「>0 时：账户为无限额度也给出 remaining = fallbackTotal - used」；
  //    §5.2 的 events 定义是「unlimited **且 fallbackTotal<=0**」；§6.1 同理。
  //    所以 `unlimited:true` + 有限 `remaining`（fallbackTotal 路径）**必须**走 balance。
  //    （本机中转站 compat 恒为哨兵 1e8 → unlimited 恒 true，fallbackTotal 是唯一能显示
  //      数值余额的 compat 路径，顺序写反会让这个产品目标彻底失效。）
  if (finiteNumber(remaining)) {
    const creditNote = coverage.mode !== undefined && coverage.mode !== null && coverage.mode !== 'money'
      ? `（normalizeBalance.mode=${str(coverage.mode)}，已按其数值直接下发）`
      : ''
    const unlimitedNote = coverage.unlimited === true
      ? `无限额度 + fallbackTotal 兜底（remaining=${remaining}）`
      : ''
    return { ok: true, failed, reason: '', remaining, note: creditNote, unlimitedNote }
  }
  // 到这里说明没有有限数值可下发。无限额度且无 fallbackTotal → 本来就没有「余额」这个数字（§5.1.1 口径 2）
  if (coverage.unlimited === true) {
    return {
      ok: false,
      failed,
      reason: `上游账号为无限额度（unlimited=true，source=${str(coverage.source) || '未知'}）且未配置 fallbackTotal，拿不到真实余额数字`,
      remaining: null,
    }
  }
  if (failed) {
    return {
      ok: false,
      failed: true,
      reason: `上游取数失败（code=${str(coverage.code) || '未知'}: ${str(coverage.error) || '无错误信息'}）`,
      remaining: null,
    }
  }
  return {
    ok: false,
    failed: false,
    reason: `remaining 不是有限数值（实际 ${remaining === null ? 'null' : typeof remaining}${coverage.ok === undefined ? '' : `, ok=${String(coverage.ok)}`}）`,
    remaining: null,
  }
}

function modelIdOf(cfg, ctxInfo) {
  const raw = str(ctxInfo.modelId) || str(cfg.modelId) || DEFAULT_WHALE_MODEL_ID
  // SPEC §4：条目 id 只允许 [A-Za-z0-9_-]（同时避免 JSON 路径/路由里出现奇怪字符）
  return raw.replace(/[^A-Za-z0-9_-]/g, '_')
}

function matchIdsOf(cfg, ctxInfo) {
  const raw = ctxInfo.matchIds !== undefined ? ctxInfo.matchIds : cfg.matchIds
  if (Array.isArray(raw)) {
    const list = raw.map(str).filter(Boolean)
    if (list.length) return list
  }
  return [...DEFAULT_MATCH_IDS]
}

// ---------------------------------------------------------------------------
// 条目构造
// ---------------------------------------------------------------------------

/**
 * SPEC §5.2：构造小鲸鱼模型条目。
 *
 * 与 `lib/index.js`（core）的实际调用形状对齐：
 *   cfg      = 归一化配置（SPEC §4 全 16 键）+ `balance`（normalizeBalance 结果，SPEC §5.1.1）
 *              + `balanceOk`（= balance.ok）+ `unlimited` + `balanceMode`（'balance'|'events'）
 *   ctxInfo  = { bridgeUrl, credentialRef, modelId, modelName, currency, matchIds, relayBaseUrl }
 *
 * 兼容三种余额入参写法（谁先出现谁生效）：
 *   · `cfg.balance`          — core 的形状（normalizeBalance 输出，可能是 {ok:false,code,error}）
 *   · `cfg.coverage`         — SPEC §5.1.1 的文档名
 *   · 扁平字段 `cfg.ok/remaining/unlimited/total/used/mode/...`
 *
 * 模式判定：`Number.isFinite(remaining)` → `balance`，否则 `events`；
 * 上游**取数失败**（`ok:false` / `balanceOk===false`）时**不降级**，保持 `balance`
 * 让挂件显示错误行而不是把数字变成「—」（详见 docs/WHALE-CONTRACT.md §3.2）。
 *
 * @param {object} cfg
 * @param {object} ctxInfo
 * @returns {{entry:object, mode:'balance'|'events', warnings:string[]}}
 *          `entry` 是可 JSON.stringify 的普通对象，**不含任何凭据明文**
 *          （`balance.auth` 只是字面量占位符 `Bearer {key}`）。
 */
export function buildWhaleEntry(cfg, ctxInfo) {
  const c = isPlainObject(cfg) ? cfg : {}
  const x = isPlainObject(ctxInfo) ? ctxInfo : {}
  const warnings = []

  const modelId = modelIdOf(c, x)
  const modelName = str(x.modelName) || str(c.modelName) || DEFAULT_WHALE_MODEL_NAME
  const currency = (str(x.currency) || str(c.currency) || 'CNY').toUpperCase()
  const credentialRef = str(x.credentialRef) || str(c.credentialRef)
  const relayBaseUrl = str(x.relayBaseUrl) || str(c.relayBaseUrl) || str(c.baseUrl)
  const bridgeBaseUrl = str(x.bridgeUrl) || str(c.bridgeUrl) || str(c.bridgeBaseUrl)
  const matchIds = matchIdsOf(c, x)

  if (!credentialRef) warnings.push('未提供 credentialRef：小鲸鱼会把该条目显示为「未配置 API key」（keyForDestination 第 2107 行）')
  if (!relayBaseUrl) warnings.push('未提供 relayBaseUrl：条目 baseUrl 为空，挂件里无法回填中转站地址')

  // 余额快照：显式 coverage > balance 字段 > 扁平字段摊平
  let coverage = c.coverage !== undefined ? c.coverage : c.balance
  if (coverage === undefined || coverage === null) {
    const flat = {}
    for (const k of ['ok', 'unlimited', 'remaining', 'total', 'used', 'mode', 'credits', 'usedUsd', 'currency', 'source']) {
      if (c[k] !== undefined) flat[k] = c[k]
    }
    coverage = Object.keys(flat).length ? flat : null
  }

  const failed = c.balanceOk === false || (isPlainObject(coverage) && coverage.ok === false)
  const survey = surveyBalance(coverage)
  // failed 只对「没有有限数值可下发」的快照兜底：core 在 balance.ok===false 时不会调本函数，
  // 这里保持 balance 让挂件显示错误行而不是把数字变成「—」（见 docs/WHALE-CONTRACT.md §3.2）。
  let mode = survey.ok || failed ? 'balance' : 'events'

  // core 的口径（由 lib/index.js 追加的字段）：
  //   cfg.balanceMode = Number.isFinite(balance.remaining) ? 'balance' : 'events'
  // 约定：不一致时以本模块判定为准，但要记一条 warning；且 hint='events' 必须真的落成 events
  // （否则会出现「它算 events、我写成 balance」的静默不一致）。有失败标记时不降级。
  const hint = str(c.balanceMode)
  if (hint === 'events' && mode === 'balance' && !failed) {
    mode = 'events'
    warnings.push(`cfg.balanceMode='events' 与余额快照不一致（remaining=${String(survey.remaining)}），按 balanceMode 降级为 events`)
  } else if (hint === 'balance' && mode === 'events') {
    warnings.push(`cfg.balanceMode='balance' 与余额快照不一致（${survey.reason}），以本模块判定为准：events`)
  }

  if (failed && !survey.ok) {
    // 上游临时失败（超时/401/网络）：**保持 balance 模式**，不静默降级。
    // 理由：降级会把挂件里的余额从数字变成「—」，用户会以为接入坏了；
    // SPEC §6.1 要求上游异常时 /balance 仍回 HTTP 200 + 业务错误行，这正是正确的表现。
    if (mode === 'balance') {
      warnings.push(`余额取数失败，保持 balance 模式（挂件显示错误行，不降级为 events）：${survey.reason}`)
    }
  } else if (mode === 'events') {
    warnings.push(`降级为 events 模式（挂件显示「余额 —」+ 本机会话估算的「今日已用」）：${survey.reason}`)
  }
  // 只有在没因口径降级时才复述口径备注，避免同一件事报两遍
  if (survey.note && mode === 'balance') warnings.push(`注意：${survey.note}`)
  if (survey.unlimitedNote && mode === 'balance') warnings.push(`注意：${survey.unlimitedNote}`)

  const entry = {
    id: modelId,
    name: modelName,
    provider: 'custom',
    currency,
    keyRef: credentialRef,
    baseUrl: relayBaseUrl,
    // balance.url 指向 DSH 本机回环路由。宿主 originOfUrl（第 2063-2069 行）只接受 http/https，
    // 回环地址是**允许的**（第 2033-2038 行注释明确说明不拦回环，New API 自建网关就是正当用法）。
    balance: {
      url: `${bridgeBaseUrl}${BALANCE_ROUTE_PATH}`,
      // 原样下发字面量 `Bearer {key}`：apiFetchJson 第 2145-2146 行做
      // `String(auth).replace('{key}', key)`，凭据此时**只存在于宿主内存**，绝不进注册表文件。
      auth: 'Bearer {key}',
      json: { remaining: BALANCE_JSON_PATH },
    },
    matchIds,
    // 必须为 true：我们的 balance.url 是回环自定义 origin，既不在任何厂商模板
    // templateOrigins 里（第 2070-2082 行），也不含 {base} 可被模板认领。
    // 为 false 时 credentialMayGoTo（第 2084-2089 行）返回 false → keyForDestination
    // 返回 code 'DEST_NOT_ALLOWED'，余额永远取不到。
    allowCustomHost: true,
  }

  if (mode === 'events') {
    // SPEC §5.2：events 模式**不带可用 balance.url**（宿主据此走 balanceMode='events'，第 2795 行）。
    // 这里保留字段骨架并置空串，而不是删键 —— 空串会被 mergeNonEmpty 跳过（第 2014 行），
    // 因此 mergeNonEmpty(tpl.balance, entry.balance) 不会凭空造出一个 URL。
    entry.balance = { url: '', auth: '', json: { remaining: '' } }
  }

  return { entry, mode, warnings }
}

/**
 * SPEC §5.2：给人看的条目摘要（**不含任何密钥**；auth 是字面量占位符，不含真实值）。
 * @param {object} entry
 * @returns {string}
 */
export function describeEntry(entry) {
  if (!isPlainObject(entry)) return '(空条目)'
  const b = isPlainObject(entry.balance) ? entry.balance : {}
  const hasUrl = !!str(b.url)
  const parts = [
    `id=${str(entry.id) || '(无)'}`,
    `name=${str(entry.name) || '(无)'}`,
    `provider=${str(entry.provider) || '(无)'}`,
    `currency=${str(entry.currency) || '(无)'}`,
    `keyRef=${str(entry.keyRef) || '(无)'}`,
    `baseUrl=${str(entry.baseUrl) || '(无)'}`,
    `余额接口=${hasUrl ? str(b.url) : '(无 → events 模式，余额显示「—」)'}`,
    `allowCustomHost=${entry.allowCustomHost === true}`,
    `matchIds=${Array.isArray(entry.matchIds) ? entry.matchIds.join(',') : '(无)'}`,
  ]
  return parts.join(' · ')
}

// ---------------------------------------------------------------------------
// 纯函数（供 changed 判定）
// ---------------------------------------------------------------------------

/**
 * 判断一个小鲸鱼模型条目是不是「我们写的」。
 *
 * 双重判据：id 相等 **且** 是 provider='custom' 的自定义条目。
 * 之所以要第二重：内置 `deepseek` 条目由宿主合成、不落注册表（第 1976-1982 行）；
 * 而用户完全可能自己手建一个同 id 的条目 —— 那种情况下我们不该把它当成自己的删掉。
 * 反过来，`id` 相同但 provider 不是 custom 的条目，`upsertWhaleEntry` 也不会碰它的身份。
 *
 * @param {object} entry
 * @param {string} modelId
 * @returns {boolean}
 */
export function isEntryOurs(entry, modelId) {
  if (!isPlainObject(entry)) return false
  const id = str(modelId) || DEFAULT_WHALE_MODEL_ID
  if (str(entry.id) !== id) return false
  return str(entry.provider) === 'custom'
}

/** 规范化一份 JSON 值（对象键排序），用于键序无关的等价比较。 */
function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical)
  if (isPlainObject(v)) {
    const out = {}
    for (const k of Object.keys(v).sort()) out[k] = canonical(v[k])
    return out
  }
  return v
}

/**
 * 条目等价判定（键序无关、数组顺序敏感、缺失键 ≠ 值为 null）。
 * 用于 `changed` 判定：等价则**不落盘**（SPEC §5.3）。
 *
 * @param {object} a
 * @param {object} b
 * @returns {boolean}
 */
export function entriesEqual(a, b) {
  if (a === b) return true
  if (!isPlainObject(a) || !isPlainObject(b)) return false
  try {
    return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))
  } catch {
    return false
  }
}
