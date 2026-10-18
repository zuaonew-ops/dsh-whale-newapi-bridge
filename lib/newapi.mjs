/**
 * New API 中转站上游客户端 + SPEC §5.1 冻结的纯函数。
 *
 * 设计要点（对应 SPEC §5.1 / §7）：
 * - 纯函数（normalizeBaseUrl / parseRelayStatus / normalizeBalance）不碰网络，可离线单测；
 * - 网络函数（fetchRelayStatus / fetchNativeUser / fetchCompat / fetchModelIds）全部接受注入的
 *   `fetchImpl`，超时走 AbortSignal，HTTP 状态映射到固定 code，非 JSON 与形状错误分开报；
 * - 任何错误消息都经过 {@link redactText} 脱敏，绝不带凭据明文；
 * - 只允许 http/https 上游，不接受 URL 里的 userinfo / query / hash（SPEC §7.3）。
 *
 * 额外导出（SPEC §5.1 之外的增量，供 index.js 与本机自测使用，不改变已冻结的签名）：
 * `DEFAULT_QUOTA_PER_UNIT`、`DEFAULT_USD_TO_CNY`、`UNLIMITED_CODE`、`redactText`、
 * `requestJson`、`fetchModelIds`、`isFiniteNumber`。
 *
 * @module dsh-whale-newapi-bridge/newapi
 */

/** 中转站默认根地址（SPEC §5.1）。 */
export const DEFAULT_BASE_URL = 'http://127.0.0.1:3000'

/** compat 模式下 hard_limit_usd 的「无限额度」哨兵（SPEC §5.1）。 */
export const UNLIMITED_SENTINEL = 100000000

/** `/api/status` 拿不到 quota_per_unit 时的兜底（SPEC §1 实测 500000）。 */
export const DEFAULT_QUOTA_PER_UNIT = 500000

/** `/api/status` 拿不到 usd_exchange_rate 时的兜底（SPEC §1 实测 7.3）。 */
export const DEFAULT_USD_TO_CNY = 7.3

/** 无限额度时的固定 code（SPEC §5.1 code 表）。 */
export const UNLIMITED_CODE = 'UNLIMITED'

/** 默认上游超时（SPEC §4 requestTimeoutMs）。 */
const DEFAULT_TIMEOUT_MS = 15000

/** 错误消息最长保留字符数（脱敏后再截断）。 */
const MAX_ERROR_CHARS = 200

/**
 * SPEC §10.5：native 的 `credits`（quota 或 remain_quota）超过「100 万面板单位」就视为荒诞值。
 *
 * 无限额度账户的 `quota` 可能是 `-1`/`0`/天文数字，负余额或 1e12 级余额不仅显示垃圾数字，
 * 还会撞上小鲸鱼记账内核 `moneyUnits()` 的 `Number.isSafeInteger(value × 1e8)`（约 >9×10⁷ 即抛
 * 「金额无效或超出可记账范围」）。100 万面板单位远超任何正常中转站余额，且换算后仍在安全范围内。
 */
const INSANE_CREDITS_PANEL_UNITS = 1e6

/** 只报数量级，避免把巨大/异常的原始值整段写进 note（SPEC §10.5）。 */
function magnitudeOf(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return String(value)
  if (value === 0) return '0'
  const abs = Math.abs(value)
  if (abs >= 1e6 || abs < 1e-3) return value.toExponential(2)
  return String(Math.round(value * 1000) / 1000)
}

// ── 脱敏 ────────────────────────────────────────────────────────────────────

/**
 * 把一段文本里的凭据形态内容抹掉：显式传入的密钥值、`sk-…` 形态、以及
 * `authorization/api_key/token=…` 这类键值对。所有对外可见的字符串都先过这里。
 *
 * @param value - 任意待脱敏内容（会被 String()）。
 * @param secrets - 已知的密钥明文（长度 >= 6 才替换，避免误伤）。
 * @returns 脱敏并截断后的字符串。
 */
export function redactText(value, secrets = []) {
  let text = value === null || value === undefined ? '' : String(value)
  const list = Array.isArray(secrets) ? secrets : [secrets]
  for (const secret of list) {
    if (typeof secret === 'string' && secret.length >= 6) {
      text = text.split(secret).join(`<redacted:len=${secret.length}>`)
    }
  }
  text = text.replace(/sk-[A-Za-z0-9_-]{4,}/g, 'sk-***')
  text = text.replace(
    /(authorization|api[-_]?key|access[-_]?token|secret)["'\s:=]+[^\s"',}]{6,}/gi,
    '$1=<redacted>',
  )
  if (text.length > MAX_ERROR_CHARS) text = `${text.slice(0, MAX_ERROR_CHARS)}…`
  return text
}

// ── 基础工具 ────────────────────────────────────────────────────────────────

/**
 * 是否为有限数值（拒绝 NaN/Infinity/字符串）。
 *
 * @param value - 待判定值。
 * @returns 布尔。
 */
export function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function finiteOrNull(value) {
  if (isFiniteNumber(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function positiveOrNull(value) {
  const n = finiteOrNull(value)
  return n !== null && n > 0 ? n : null
}

function firstPositive(values) {
  for (const value of values) {
    const n = positiveOrNull(value)
    if (n !== null) return n
  }
  return null
}

function round2(value) {
  return Math.round(value * 100) / 100
}

function normalizeCurrency(value) {
  const text = typeof value === 'string' ? value.trim().toUpperCase() : ''
  return text === 'USD' ? 'USD' : 'CNY'
}

/**
 * HTTP 状态 → SPEC §5.1 固定 code。
 *
 * @param status - HTTP 状态码。
 * @returns 固定 code 字符串。
 */
function httpCodeOf(status) {
  if (status === 401) return 'HTTP_401'
  if (status === 403) return 'HTTP_403'
  if (status === 404) return 'HTTP_404'
  return 'HTTP_ERROR'
}

// ── normalizeBaseUrl ────────────────────────────────────────────────────────

/**
 * 归一化上游根地址：去尾斜杠，只允许 http/https，不接受 userinfo/query/hash。
 *
 * @param raw - 用户配置的地址。
 * @returns 归一化后的地址（`scheme://host[:port][/path]`）。
 * @throws Error - 空、非法 URL、非 http(s)、带 userinfo、带 query/hash。
 */
export function normalizeBaseUrl(raw) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text === '') throw new Error('地址为空')
  let url
  try {
    url = new URL(text)
  } catch {
    throw new Error('不是合法的 URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`只允许 http/https，收到 ${url.protocol}`)
  }
  if (url.username !== '' || url.password !== '') throw new Error('不允许携带用户名/密码')
  if (url.search !== '' || url.hash !== '') throw new Error('不允许携带查询串或片段')
  const pathname = url.pathname.replace(/\/+$/, '')
  return `${url.protocol}//${url.host}${pathname}`
}

/**
 * SPEC §10.2：只接受「回环 origin」的 http(s) 地址，不合格返回 `null`。
 *
 * 用途：`config.bridgeBaseUrl` 与 `POST /sync` 的 `bridgeBaseUrl` 覆盖 —— 它们最终会写进
 * 小鲸鱼条目的 `balance.url`，而条目带 `allowCustomHost:true`，等于决定挂件把中转站凭据发往哪里。
 * 因此只允许 hostname ∈ {`localhost`, `*.localhost`, `127.0.0.0/8`, `::1`}（端口任意），
 * 并沿用 `normalizeBaseUrl` 的其它限制（http/https、无 userinfo、无 query/hash）。
 *
 * @param raw - 待校验的地址。
 * @returns 归一化后的地址；不合格为 `null`（调用方决定是忽略+warning 还是 400）。
 */
export function normalizeLoopbackBaseUrl(raw) {
  const inspected = inspectLoopbackBaseUrl(raw)
  if (inspected.ok !== true) return null
  try {
    return normalizeBaseUrl(String(raw).trim())
  } catch {
    return null
  }
}

/**
 * 与 `normalizeLoopbackBaseUrl` 同判据，但返回**拒绝原因**（用于 warning / 400 文案）。
 *
 * @param raw - 待校验的地址。
 * @returns 合格时 `null`，否则一句中文原因。
 */
export function explainLoopbackBaseUrl(raw) {
  const inspected = inspectLoopbackBaseUrl(raw)
  return inspected.ok === true ? null : inspected.reason
}

function inspectLoopbackBaseUrl(raw) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text === '') return { ok: false, reason: '地址为空' }
  let url
  try {
    url = new URL(text)
  } catch {
    return { ok: false, reason: '不是合法的 URL' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `只允许 http/https，收到 ${url.protocol}` }
  }
  if (url.username !== '' || url.password !== '') return { ok: false, reason: '不允许携带用户名/密码' }
  const hostname = url.hostname.toLowerCase().replace(/^\[/u, '').replace(/\]$/u, '')
  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(hostname)
  const isLoopback = hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname === '::1'
    || (octets !== null && octets[1] === '127' && octets.slice(2).every((part) => Number(part) <= 255))
  if (!isLoopback) {
    return { ok: false, reason: `hostname ${url.hostname} 不是回环地址（只允许 localhost/*.localhost/127.0.0.0/8/::1）` }
  }
  return { ok: true, url }
}

// ── parseRelayStatus ────────────────────────────────────────────────────────

/**
 * 解析 `GET {base}/api/status` 的响应（公开接口，无需凭据）。
 * 兼容 `{success, data:{…}}` 包装与直接给数据对象两种形态。
 *
 * @param json - 已解析的 JSON。
 * @returns 成功时 SPEC §5.1 列出的 9 个字段；失败时 `{ ok:false, error }`。
 */
export function parseRelayStatus(json) {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    return { ok: false, error: '响应不是 JSON 对象' }
  }
  const data = json.data !== null && typeof json.data === 'object' && !Array.isArray(json.data)
    ? json.data
    : json
  if (data !== json && json.success === false) {
    return { ok: false, error: `上游返回失败（${redactText(json.message ?? '')}）` }
  }
  const str = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null)
  const bool = (value) => (typeof value === 'boolean' ? value : null)
  const out = {
    ok: true,
    version: str(data.version),
    systemName: str(data.system_name ?? data.systemName),
    quotaPerUnit: finiteOrNull(data.quota_per_unit ?? data.quotaPerUnit),
    usdExchangeRate: finiteOrNull(
      data.usd_exchange_rate ?? data.price ?? data.usdExchangeRate,
    ),
    displayInCurrency: bool(data.display_in_currency ?? data.displayInCurrency),
    quotaDisplayType: str(data.quota_display_type ?? data.quotaDisplayType),
    customCurrencySymbol: str(data.custom_currency_symbol ?? data.customCurrencySymbol),
    customCurrencyExchangeRate: finiteOrNull(
      data.custom_currency_exchange_rate ?? data.customCurrencyExchangeRate,
    ),
  }
  if (out.version === null && out.systemName === null && out.quotaPerUnit === null) {
    return { ok: false, error: '未识别出 New API 状态字段（version/system_name/quota_per_unit 全缺）' }
  }
  return out
}

// ── HTTP 层 ─────────────────────────────────────────────────────────────────

function makeTimeoutSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    try {
      return { signal: AbortSignal.timeout(ms), cancel: null }
    } catch {
      /* 落到下面的 AbortController 分支 */
    }
  }
  if (typeof AbortController === 'function') {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      try {
        controller.abort()
      } catch {
        /* 忽略 */
      }
    }, ms)
    if (timer && typeof timer.unref === 'function') timer.unref()
    return { signal: controller.signal, cancel: () => clearTimeout(timer) }
  }
  return { signal: undefined, cancel: null }
}

function resolveFetch(fetchImpl) {
  if (typeof fetchImpl === 'function') return fetchImpl
  if (typeof globalThis.fetch === 'function') return globalThis.fetch
  return null
}

function resolveTimeout(timeoutMs) {
  const n = finiteOrNull(timeoutMs)
  if (n === null || n <= 0) return DEFAULT_TIMEOUT_MS
  return Math.max(1, Math.floor(n))
}

async function readJsonBodyOfResponse(res, secrets) {
  let text
  try {
    text = await res.text()
  } catch (err) {
    return { ok: false, code: 'NETWORK', error: `读取响应体失败：${redactText(err?.message ?? err, secrets)}` }
  }
  if (typeof text !== 'string' || text.trim() === '') {
    return { ok: false, code: 'NON_JSON', error: '响应体为空（不是 JSON）' }
  }
  try {
    return { ok: true, json: JSON.parse(text) }
  } catch {
    return {
      ok: false,
      code: 'NON_JSON',
      error: `响应不是 JSON（前 80 字符：${redactText(text.slice(0, 80), secrets)}）`,
    }
  }
}

/**
 * 发一个 JSON GET/POST 并把结果归一成固定 code 的判别联合。
 * 不抛异常：网络/超时/非 JSON/HTTP 错误全部映射为 `{ ok:false, code, error, httpStatus? }`。
 *
 * @param url - 完整 URL（调用方保证已归一化）。
 * @param options - `{ method?, headers?, body?, fetchImpl?, timeoutMs?, secrets? }`。
 * @returns `{ ok:true, json, httpStatus }` 或 `{ ok:false, code, error, httpStatus? }`。
 */
export async function requestJson(url, options = {}) {
  const secrets = Array.isArray(options.secrets) ? options.secrets : []
  const doFetch = resolveFetch(options.fetchImpl)
  if (doFetch === null) return { ok: false, code: 'NETWORK', error: '运行时没有可用的 fetch 实现' }
  const ms = resolveTimeout(options.timeoutMs)
  const { signal, cancel } = makeTimeoutSignal(ms)
  let res
  try {
    res = await doFetch(url, {
      method: options.method ?? 'GET',
      headers: options.headers ?? {},
      body: options.body,
      signal,
      redirect: 'manual', // 不跟随跳转：带着凭据跨主机跳转是凭据外带路径（SPEC §7）
    })
  } catch (err) {
    const name = String(err?.name ?? '')
    if (name === 'TimeoutError' || name === 'AbortError') {
      return { ok: false, code: 'TIMEOUT', error: `请求超时（${ms}ms）` }
    }
    return { ok: false, code: 'NETWORK', error: `网络错误：${redactText(err?.message ?? err, secrets)}` }
  } finally {
    if (typeof cancel === 'function') cancel()
  }
  const status = isFiniteNumber(Number(res?.status)) ? Number(res.status) : 0
  if (status < 200 || status >= 300) {
    let detail = ''
    try {
      const text = await res.text()
      if (typeof text === 'string' && text.trim() !== '') {
        detail = `：${redactText(text.slice(0, 80), secrets)}`
      }
    } catch {
      /* 读不出来就算了，状态码已经足够诊断 */
    }
    return {
      ok: false,
      code: httpCodeOf(status),
      error: `上游返回 HTTP ${status}${detail}`,
      httpStatus: status,
    }
  }
  const parsed = await readJsonBodyOfResponse(res, secrets)
  if (!parsed.ok) return { ...parsed, httpStatus: status }
  return { ok: true, json: parsed.json, httpStatus: status }
}

// ── fetchRelayStatus ────────────────────────────────────────────────────────

/**
 * `GET {base}/api/status`（公开）。
 *
 * @param baseUrl - 中转站根地址。
 * @param deps - `{ fetchImpl?, timeoutMs? }`。
 * @returns `{ ok:true, status }`（status 为 {@link parseRelayStatus} 结果）
 *          或 `{ ok:false, code, error, httpStatus? }`。
 */
export async function fetchRelayStatus(baseUrl, deps = {}) {
  let base
  try {
    base = normalizeBaseUrl(baseUrl)
  } catch (err) {
    return { ok: false, code: 'SHAPE', error: `baseUrl 非法：${err.message}` }
  }
  const res = await requestJson(`${base}/api/status`, {
    fetchImpl: deps.fetchImpl,
    timeoutMs: deps.timeoutMs,
  })
  if (!res.ok) return res
  const parsed = parseRelayStatus(res.json)
  if (!parsed.ok) return { ok: false, code: 'SHAPE', error: parsed.error, httpStatus: res.httpStatus }
  return { ok: true, status: parsed }
}

// ── fetchNativeUser ─────────────────────────────────────────────────────────

/**
 * 把 `/api/user/self` 的 `data` 投影成**白名单字段**（绝不透传整个用户对象：
 * 该接口会返回 `access_token` 等敏感字段，透传就有泄漏路径）。
 *
 * @param json - 已解析的响应。
 * @returns 投影后的用户对象，或 null（形状不对）。
 */
function extractNativeUser(json) {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) return null
  const data = json.data !== undefined ? json.data : json
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null
  const keys = ['quota', 'remain_quota', 'used_quota', 'unlimited_quota']
  if (!keys.some((key) => key in data)) return null
  const group = typeof data.group === 'string'
    ? data.group
    : (data.group && typeof data.group === 'object' && typeof data.group.name === 'string' ? data.group.name : null)
  return {
    quota: finiteOrNull(data.quota),
    used_quota: finiteOrNull(data.used_quota) ?? 0,
    remain_quota: 'remain_quota' in data ? finiteOrNull(data.remain_quota) : null,
    unlimited_quota: data.unlimited_quota === true,
    group,
  }
}

function isAuthFailure(code) {
  return code === 'HTTP_401' || code === 'HTTP_403'
}

/**
 * `GET {base}/api/user/self`（需要用户系统访问令牌，不是 sk- 渠道 key）。
 * `userId` 非空时先带 `New-Api-User`，失败（或 userId 为空）再试不带。
 *
 * @param baseUrl - 中转站根地址。
 * @param opts - `{ token, userId?, fetchImpl?, timeoutMs? }`。
 * @returns `{ ok:true, httpStatus, user, withUserHeader }` 或 `{ ok:false, code, error, httpStatus? }`。
 */
export async function fetchNativeUser(baseUrl, opts = {}) {
  const token = typeof opts.token === 'string' ? opts.token : ''
  if (token === '') return { ok: false, code: 'NO_CREDENTIAL', error: '未配置访问令牌' }
  let base
  try {
    base = normalizeBaseUrl(baseUrl)
  } catch (err) {
    return { ok: false, code: 'SHAPE', error: `baseUrl 非法：${err.message}` }
  }
  const url = `${base}/api/user/self`
  const userId = typeof opts.userId === 'string' ? opts.userId.trim() : ''
  const attempts = []
  if (userId !== '') {
    attempts.push({ withUserHeader: true, headers: { authorization: `Bearer ${token}`, 'new-api-user': userId } })
  }
  attempts.push({ withUserHeader: false, headers: { authorization: `Bearer ${token}` } })
  let failure = null
  for (const attempt of attempts) {
    const res = await requestJson(url, {
      headers: attempt.headers,
      fetchImpl: opts.fetchImpl,
      timeoutMs: opts.timeoutMs,
      secrets: [token],
    })
    if (res.ok) {
      const user = extractNativeUser(res.json)
      if (user === null) {
        const shape = { ok: false, code: 'SHAPE', error: '/api/user/self 响应缺少额度字段', httpStatus: res.httpStatus }
        failure = failure === null || (isAuthFailure(failure.code) && !isAuthFailure(shape.code)) ? shape : failure
        continue
      }
      return { ok: true, httpStatus: res.httpStatus, user, withUserHeader: attempt.withUserHeader }
    }
    // 诊断优先：非鉴权失败比 401/403 更能说明问题，保留它
    if (failure === null || (isAuthFailure(failure.code) && !isAuthFailure(res.code))) failure = res
  }
  return failure ?? { ok: false, code: 'SHAPE', error: '未取得用户信息' }
}

// ── fetchCompat ─────────────────────────────────────────────────────────────

/**
 * usage 的 start_date/end_date 参数。
 *
 * ⚠️ New API v1.0.0-rc.40 的 `controller/billing.go` `GetUsage` **完全不解析这两个参数**，
 * 直接返回该凭据的**累计** `used_quota`（protocol 用 1970/2099/无参三种窗口实测，返回值一致）。
 * 我们照 SPEC §5.1 的签名继续带参数（对上游无副作用），但把 `window.ignored` 标成 true，
 * 并在 `detail.note` 里明确写「累计已用」而不是「窗口用量」。
 *
 * @param now - 参考时间（可注入，便于测试）。
 * @returns `{ start, end, ignored }`。
 */
function usageWindow(now = Date.now()) {
  const end = new Date(now)
  const start = new Date(now - 30 * 24 * 60 * 60 * 1000)
  const fmt = (d) => d.toISOString().slice(0, 10)
  return { start: fmt(start), end: fmt(end), ignored: true }
}

/**
 * OpenAI 兼容计费接口（Bearer sk- 渠道 key 可用）：
 * `GET /v1/dashboard/billing/subscription` + `GET /v1/dashboard/billing/usage`。
 * usage 失败**不致命**（用 `usageOk:false` 标记，normalizeBalance 会在 note 里说明）。
 *
 * @param baseUrl - 中转站根地址。
 * @param opts - `{ apiKey, fetchImpl?, timeoutMs?, now? }`。
 * @returns `{ ok:true, hardLimitUsd, usedCents, usedUsd, usageOk, usageError, window, usageKind }`
 *          或 `{ ok:false, code, error, httpStatus? }`。
 */
export async function fetchCompat(baseUrl, opts = {}) {
  const apiKey = typeof opts.apiKey === 'string' ? opts.apiKey : ''
  if (apiKey === '') return { ok: false, code: 'NO_CREDENTIAL', error: '未配置 API key' }
  let base
  try {
    base = normalizeBaseUrl(baseUrl)
  } catch (err) {
    return { ok: false, code: 'SHAPE', error: `baseUrl 非法：${err.message}` }
  }
  const headers = { authorization: `Bearer ${apiKey}` }
  const secrets = [apiKey]
  const sub = await requestJson(`${base}/v1/dashboard/billing/subscription`, {
    headers,
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs,
    secrets,
  })
  if (!sub.ok) return sub
  const hardLimitUsd = finiteOrNull(
    sub.json?.hard_limit_usd ?? sub.json?.system_hard_limit_usd ?? sub.json?.soft_limit_usd,
  )
  if (hardLimitUsd === null) {
    return { ok: false, code: 'SHAPE', error: 'subscription 响应里没有 hard_limit_usd', httpStatus: sub.httpStatus }
  }
  // hard_limit_usd 的「无限」判断放在 normalizeBalance（唯一口径来源）
  const window = usageWindow(finiteOrNull(opts.now) ?? Date.now())
  const usage = await requestJson(
    `${base}/v1/dashboard/billing/usage?start_date=${window.start}&end_date=${window.end}`,
    { headers, fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs, secrets },
  )
  let usedCents = 0
  let usageOk = false
  let usageError = null
  if (usage.ok) {
    const total = finiteOrNull(usage.json?.total_usage ?? usage.json?.total_usage_usd)
    if (total === null) {
      usageError = 'usage 响应里没有 total_usage'
    } else {
      usedCents = total
      usageOk = true
    }
  } else {
    usageError = `${usage.code}: ${usage.error}`
  }
  return {
    ok: true,
    hardLimitUsd,
    usedCents,
    usedUsd: usedCents / 100,
    usageOk,
    usageError,
    window,
    usageKind: 'cumulative',
  }
}

// ── fetchModelIds ───────────────────────────────────────────────────────────

/**
 * `GET {base}/v1/models`（Bearer sk- key 可用）→ 模型 id 列表。
 * 供 `.dshw-api.json` 条目的 `matchIds` 使用（SPEC §5.2）；失败不致命。
 *
 * @param baseUrl - 中转站根地址。
 * @param opts - `{ apiKey?, fetchImpl?, timeoutMs? }`。
 * @returns `{ ok:true, ids, httpStatus }` 或 `{ ok:false, code, error, httpStatus? }`。
 */
export async function fetchModelIds(baseUrl, opts = {}) {
  const apiKey = typeof opts.apiKey === 'string' ? opts.apiKey : ''
  let base
  try {
    base = normalizeBaseUrl(baseUrl)
  } catch (err) {
    return { ok: false, code: 'SHAPE', error: `baseUrl 非法：${err.message}` }
  }
  const res = await requestJson(`${base}/v1/models`, {
    headers: apiKey === '' ? {} : { authorization: `Bearer ${apiKey}` },
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs,
    secrets: apiKey === '' ? [] : [apiKey],
  })
  if (!res.ok) return res
  const list = Array.isArray(res.json?.data)
    ? res.json.data
    : (Array.isArray(res.json) ? res.json : [])
  const ids = []
  for (const item of list) {
    const id = typeof item === 'string' ? item : (item && typeof item.id === 'string' ? item.id : null)
    if (typeof id === 'string' && id !== '' && !ids.includes(id)) ids.push(id)
  }
  if (ids.length === 0) {
    return { ok: false, code: 'SHAPE', error: '/v1/models 未返回任何模型 id', httpStatus: res.httpStatus }
  }
  return { ok: true, ids, httpStatus: res.httpStatus }
}

// ── normalizeBalance ────────────────────────────────────────────────────────

function readRelayStatusInput(status) {
  if (status === null || typeof status !== 'object' || status.ok === false) return null
  if (status.status !== null && typeof status.status === 'object') return status.status
  return status
}

/**
 * 面板口径提示（protocol 的 docs/PROTOCOL.md §7 依据 `web/src/lib/currency.ts:187-216`）：
 * 当上游 `quota_display_type=CUSTOM` 时，面板用**自定义币种**（`custom_currency_exchange_rate`，
 * 本机 = 1，符号 credits）显示余额，`usd_exchange_rate` 不参与；而本模块按 SPEC §5.1.1 的
 * `currency==='CNY' → × usdToCny` 换算，于是数值会与面板差一个倍数。
 * 我们**不偏离 SPEC**，只把这个差异写进 `detail.note`，并在 `/status` 的 warnings 里由
 * lib/index.js 复述，供作者决定最终安装配置（改用 `currency:'USD'` + `usdToCny:1` 即可对齐面板数字）。
 *
 * @param ctx - normalizeBalance 的派生上下文。
 * @returns 说明字符串（不需要时为空串）。
 */
function panelCaliberNote(ctx) {
  const relay = ctx.relayStatus
  if (relay === null || typeof relay !== 'object') return ''
  const displayType = typeof relay.quotaDisplayType === 'string' ? relay.quotaDisplayType.trim().toUpperCase() : ''
  if (displayType !== 'CUSTOM' || ctx.currency !== 'CNY') return ''
  const customRate = finiteOrNull(relay.customCurrencyExchangeRate)
  const symbol = typeof relay.customCurrencySymbol === 'string' && relay.customCurrencySymbol !== ''
    ? relay.customCurrencySymbol
    : 'credits'
  const factor = ctx.rate / (customRate !== null && customRate > 0 ? customRate : 1)
  return ` 注意：上游 quota_display_type=CUSTOM（符号 ${symbol}，custom_currency_exchange_rate=${customRate === null ? '未知' : customRate}），`
    + `面板按该自定义币种显示、usd_exchange_rate 不参与；本结果按 currency=CNY × usd_exchange_rate=${ctx.usdExchangeRate} 换算，`
    + `数值约为面板的 ${round2(factor)} 倍。要与面板数字一致，配置应改用 currency:'USD' + usdToCny:1（见 docs/PROTOCOL.md）。`
}

function failureOf(payload, mode) {
  if (payload !== null && typeof payload === 'object' && payload.ok === false) {
    const out = {
      ok: false,
      code: typeof payload.code === 'string' && payload.code !== '' ? payload.code : 'SHAPE',
      error: typeof payload.error === 'string' && payload.error !== '' ? payload.error : '上游取数失败',
    }
    if (isFiniteNumber(payload.httpStatus)) out.httpStatus = payload.httpStatus
    return out
  }
  return {
    ok: false,
    code: 'SHAPE',
    error: mode === 'native'
      ? '缺少 /api/user/self 数据（native 模式需要用户系统访问令牌）'
      : '缺少 /v1/dashboard/billing 数据（compat 模式需要 sk- 渠道 key）',
  }
}

function buildNativeBalance(payload, ctx) {
  if (payload === null || typeof payload !== 'object' || payload.ok !== true) return null
  const user = payload.user
  if (user === null || typeof user !== 'object') return null
  const quota = finiteOrNull(user.quota)
  const remain = finiteOrNull(user.remain_quota)
  const credits = remain !== null ? remain : quota
  if (credits === null) return null
  const usedCredits = finiteOrNull(user.used_quota) ?? 0
  const unlimited = user.unlimited_quota === true
  const money = (raw) => (raw / ctx.quotaPerUnit) * ctx.rate
  const sources = []
  sources.push('数据来源：/api/user/self（New API 用户系统访问令牌）')
  sources.push(`quota_per_unit=${ctx.quotaPerUnit}`)
  sources.push(`quota=${quota === null ? 'null' : quota}`)
  sources.push(`remain_quota=${remain === null ? 'null' : remain}`)
  sources.push(`used_quota=${usedCredits}`)

  // SPEC §10.5 荒诞值护栏：credits <= 0 或 credits/quotaPerUnit > 1e6 面板单位 → 不产出数值余额。
  // 无限额度账户的 quota 常见 -1/0/天文数字，直接换算会得到负余额或 1e12 级余额（还会撞上
  // 小鲸鱼 moneyUnits() 的 Number.isSafeInteger(value×1e8) 校验），所以按 §5.1.1 规则 2 处理。
  const panelUnits = ctx.quotaPerUnit > 0 ? credits / ctx.quotaPerUnit : null
  const sanityViolation = !(credits > 0) || (panelUnits !== null && panelUnits > INSANE_CREDITS_PANEL_UNITS)
  const guardText = sanityViolation
    ? `credits=${magnitudeOf(credits)} 触发荒诞值护栏（SPEC §10.5：credits<=0 或 credits/quota_per_unit>${INSANE_CREDITS_PANEL_UNITS} 面板单位）`
    : ''
  const noNumericBalance = unlimited || sanityViolation
  const unlimitedReason = sanityViolation && !unlimited
    ? `${guardText}，故不产出数值余额`
    : '账户为无限额度（unlimited_quota=true）'

  let mode = 'money'
  let remaining = null
  let total = null
  let used = null
  let note = ''
  if (!(ctx.quotaPerUnit > 0)) {
    // 理论上不可达（quotaPerUnit 恒有兜底），保留分支以便离线测试覆盖
    mode = 'credits'
    used = usedCredits
    if (noNumericBalance) {
      remaining = ctx.fallbackTotal > 0 ? ctx.fallbackTotal - usedCredits : null
      total = remaining === null ? null : ctx.fallbackTotal
      note = `${sources.join('；')}。${unlimitedReason}${remaining === null ? '且未配置 fallbackTotal，无法给出数值余额' : `，按配置 fallbackTotal=${ctx.fallbackTotal} 估算余额`}。注意：quota_per_unit 不可用，按原始 credits 口径，未换算成 ${ctx.currency}。`
    } else {
      remaining = credits
      total = credits + usedCredits
      note = `${sources.join('；')}。注意：quota_per_unit 不可用，按原始 quota（credits）口径给出，未换算成 ${ctx.currency}。`
    }
  } else {
    used = money(usedCredits)
    if (noNumericBalance && !(ctx.fallbackTotal > 0)) {
      remaining = null
      total = null
      note = `${sources.join('；')}。${unlimitedReason}且未配置 fallbackTotal，无法给出数值余额。按 ${ctx.currency} 口径换算，1 USD = ${ctx.rate} ${ctx.currency}。`
    } else if (noNumericBalance) {
      total = ctx.fallbackTotal
      remaining = ctx.fallbackTotal - used
      note = `${sources.join('；')}。${unlimitedReason}，按配置 fallbackTotal=${ctx.fallbackTotal} 作为总额度估算余额。1 USD = ${ctx.rate} ${ctx.currency}。`
    } else {
      remaining = money(credits)
      total = remaining + used
      note = `${sources.join('；')}。非无限额度；按 ${ctx.currency} 口径换算（1 USD = ${ctx.rate} ${ctx.currency}），total = remaining + used。`
    }
  }
  note += panelCaliberNote(ctx)
  const detail = { quotaPerUnit: ctx.quotaPerUnit, usdExchangeRate: ctx.usdExchangeRate, note }
  if (isFiniteNumber(total) && total > 0 && isFiniteNumber(used)) detail.usedPct = round2((used / total) * 100)
  if (typeof user.group === 'string' && user.group !== '') detail.group = user.group
  if (sanityViolation) {
    // 只报数量级与触发原因（原始值可能是天文数字），便于 /status 诊断而不污染展示。
    detail.sanityGuard = { credits: magnitudeOf(credits), panelUnits: panelUnits === null ? null : magnitudeOf(panelUnits), threshold: INSANE_CREDITS_PANEL_UNITS }
  }
  return {
    ok: true,
    source: 'native',
    unlimited: noNumericBalance,
    remaining,
    total,
    used,
    currency: ctx.currency,
    credits,
    usedUsd: null,
    fetchedAt: Date.now(),
    mode,
    detail,
    raw: {
      quota,
      remain_quota: remain,
      used_quota: usedCredits,
      unlimited_quota: unlimited,
      group: typeof user.group === 'string' ? user.group : null,
    },
  }
}

function buildCompatBalance(payload, ctx) {
  if (payload === null || typeof payload !== 'object' || payload.ok !== true) return null
  const hardLimitUsd = finiteOrNull(payload.hardLimitUsd)
  if (hardLimitUsd === null) return null
  const usedCents = finiteOrNull(payload.usedCents) ?? 0
  const usageOk = payload.usageOk !== false
  const unlimited = hardLimitUsd >= UNLIMITED_SENTINEL
  const usedUsd = usedCents / 100
  const used = usedUsd * ctx.rate
  const sources = []
  sources.push('数据来源：/v1/dashboard/billing（subscription + usage，sk- 渠道 key）')
  sources.push(`hard_limit_usd=${hardLimitUsd}`)
  sources.push(
    `total_usage=${usedCents} 美分（=${usedUsd} USD）= 该凭据**累计**已用`
    + '（New API rc.40 忽略 start_date/end_date，protocol 实测 1970/2099/无参返回值一致）',
  )
  let total = null
  let remaining = null
  let note = ''
  if (unlimited) {
    if (ctx.fallbackTotal > 0) {
      total = ctx.fallbackTotal
      remaining = ctx.fallbackTotal - used
      note = `${sources.join('；')}。hard_limit_usd>=${UNLIMITED_SENTINEL} 表示无限额度；按配置 fallbackTotal=${ctx.fallbackTotal} 作为总额度估算余额（1 USD = ${ctx.rate} ${ctx.currency}）。`
    } else {
      note = `${sources.join('；')}。hard_limit_usd>=${UNLIMITED_SENTINEL} 表示无限额度且未配置 fallbackTotal，无法给出数值余额（remaining=null）。`
    }
  } else {
    total = hardLimitUsd * ctx.rate
    remaining = total - used
    note = `${sources.join('；')}。非无限额度；按 ${ctx.currency} 口径换算（1 USD = ${ctx.rate} ${ctx.currency}），total = hard_limit_usd × 汇率，remaining = total - used。`
  }
  if (!usageOk) {
    note += ` 注意：usage 接口不可用（${redactText(payload.usageError ?? '未知原因')}），今日已用按 0 计。`
  }
  // 单位护栏（protocol 依据 controller/billing.go:41-66）：只有当 quota_display_type
  // 是 USD/CUSTOM 时，billing 的 *_usd 字段才是美元；其它类型下它不是美元，必须明说。
  const displayType = ctx.relayStatus !== null
    && typeof ctx.relayStatus.quotaDisplayType === 'string'
    && ctx.relayStatus.quotaDisplayType.trim() !== ''
    ? ctx.relayStatus.quotaDisplayType.trim().toUpperCase()
    : null
  if (displayType !== null && displayType !== 'USD' && displayType !== 'CUSTOM') {
    note += ` 注意：上游 quota_display_type=${displayType}，此时 billing 的 *_usd 字段并非美元口径（见 docs/PROTOCOL.md），本结果按美元换算，仅供参考。`
  }
  note += panelCaliberNote(ctx)
  const detail = { quotaPerUnit: ctx.quotaPerUnit, usdExchangeRate: ctx.usdExchangeRate, note }
  if (isFiniteNumber(total) && total > 0 && isFiniteNumber(used)) detail.usedPct = round2((used / total) * 100)
  return {
    ok: true,
    source: 'compat',
    unlimited,
    remaining,
    total,
    used,
    currency: ctx.currency,
    credits: null,
    usedUsd,
    fetchedAt: Date.now(),
    mode: 'money',
    detail,
    raw: {
      hard_limit_usd: hardLimitUsd,
      total_usage: usedCents,
      used_usd: usedUsd,
      unlimited_quota: unlimited,
      usage_ok: usageOk,
    },
  }
}

/**
 * 把上游取数结果归一成**唯一余额形状**（SPEC §5.1.1）。纯函数。
 *
 * @param input - `{ mode:'native'|'compat'|'auto', native?, compat?, status?, config }`；
 *   `status` 既接受 {@link fetchRelayStatus} 的包装 `{ok:true,status}`，也接受
 *   {@link parseRelayStatus} 的直接结果。
 * @returns 成功：SPEC §5.1.1 的字段集合（`remaining` 在无限额度且无 fallbackTotal 时为 null）；
 *   失败：`{ ok:false, code, error, httpStatus? }`。
 */
export function normalizeBalance(input) {
  const source = input !== null && typeof input === 'object' ? input : {}
  const cfg = source.config !== null && typeof source.config === 'object' ? source.config : {}
  const requested = source.mode === 'native' || source.mode === 'compat' ? source.mode : 'auto'
  const relay = readRelayStatusInput(source.status)
  const ctx = {
    quotaPerUnit: firstPositive([cfg.quotaPerUnit, relay?.quotaPerUnit, DEFAULT_QUOTA_PER_UNIT]),
    usdExchangeRate: firstPositive([cfg.usdToCny, relay?.usdExchangeRate, DEFAULT_USD_TO_CNY]),
    currency: normalizeCurrency(cfg.currency),
    fallbackTotal: finiteOrNull(cfg.fallbackTotal) ?? 0,
    relayStatus: relay,
  }
  if (ctx.fallbackTotal < 0) ctx.fallbackTotal = 0
  ctx.rate = ctx.currency === 'CNY' ? ctx.usdExchangeRate : 1
  const order = requested === 'auto' ? ['native', 'compat'] : [requested]
  let failure = null
  for (const mode of order) {
    const payload = mode === 'native' ? source.native : source.compat
    const built = mode === 'native' ? buildNativeBalance(payload, ctx) : buildCompatBalance(payload, ctx)
    if (built !== null) return built
    if (failure === null) failure = failureOf(payload, mode)
  }
  return failure ?? { ok: false, code: 'SHAPE', error: '没有可用的余额数据源（native/compat 都缺失）' }
}
