#!/usr/bin/env node
/**
 * dsh-whale-newapi-bridge — New API 中转站协议探测器（零依赖）
 *
 * 用途：对一台 New API 中转站依次探测余额/用量相关的公开与鉴权接口，
 *       给出真实 HTTP 状态与响应摘要，并可选导出**脱敏** fixture。
 *
 * 用法：
 *   node test/probe-relay.mjs                     # 人类可读输出
 *   node test/probe-relay.mjs --json              # 机器可读 JSON（唯一 stdout 内容）
 *   node test/probe-relay.mjs --base-url http://host:port
 *   node test/probe-relay.mjs --ref PI_API_KEY    # 指定 .credentials.yaml 里的 refs 键
 *   node test/probe-relay.mjs --write-fixtures    # 把脱敏响应写入 test/fixtures/
 *   node test/probe-relay.mjs --check-window      # 证明 billing/usage 忽略日期参数（累计值）
 *   node test/probe-relay.mjs --access-token sk-… # 额外探测 native 模式 /api/user/self
 *
 * 安全：
 *   - 密钥只用于发起请求；**任何输出（stdout/stderr/JSON/错误消息）都脱敏**为 `sk-***`。
 *   - 只接受 http:/https: 且不接受带 userinfo 的 URL。
 *   - 默认超时 15s；`--timeout-ms` 可改。
 *
 * 退出码：0 = 所有**必需**检查通过；1 = 有必需检查失败；2 = 用法/配置错误。
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

export const DEFAULT_BASE_URL = 'http://127.0.0.1:3000'
export const PROBE_SCHEMA = 'dsh-whale-newapi-bridge/probe-relay@1'

/** 与 SPEC §5.1 一致的无限额度哨兵值。 */
export const UNLIMITED_SENTINEL = 100000000

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const FIXTURES_DIR = path.resolve(HERE, 'fixtures')

// ---------------------------------------------------------------------------
// 脱敏
// ---------------------------------------------------------------------------

const SECRET_RE = /\bsk-[A-Za-z0-9_-]{6,}\b/g
const SECRET_KEY_RE = /^(api[-_]?key|key|token|access[-_]?token|authorization|secret|password)$/i

/** 把任意字符串里的 sk-… 替换成 sk-***（保留长度信息）。 */
export function redactText(value) {
  if (typeof value !== 'string') return value
  return value.replace(SECRET_RE, (m) => `sk-***len=${m.length}`)
}

/**
 * 递归脱敏：抹掉形如 sk-… 的字符串、以及键名敏感的对象值。
 * 返回新对象，不修改入参。
 */
export function redactDeep(value, depth = 0) {
  if (depth > 12) return '[depth-limit]'
  if (typeof value === 'string') return redactText(value)
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY_RE.test(k) && typeof v === 'string') {
        out[k] = `sk-***len=${v.length}`
      } else {
        out[k] = redactDeep(v, depth + 1)
      }
    }
    return out
  }
  return value
}

/** 展示用：不泄露任何字符，只给前缀类别与长度。 */
export function maskSecret(secret) {
  if (typeof secret !== 'string' || secret.length === 0) return '(none)'
  const prefix = secret.startsWith('sk-') ? 'sk-' : secret.slice(0, 2)
  return `${prefix}***len=${secret.length}`
}

// ---------------------------------------------------------------------------
// 凭据读取（极简 YAML 子集解析：只认顶层 `refs:` 下的 `KEY: value`）
// ---------------------------------------------------------------------------

export function defaultCredentialsFile() {
  if (process.env.DSH_CREDENTIALS_FILE) return process.env.DSH_CREDENTIALS_FILE
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir()
  return path.join(home, '.dsh', '.credentials.yaml')
}

function unquote(raw) {
  let v = raw.trim()
  if (
    (v.startsWith('"') && v.endsWith('"') && v.length >= 2) ||
    (v.startsWith("'") && v.endsWith("'") && v.length >= 2)
  ) {
    v = v.slice(1, -1)
  }
  return v
}

/**
 * 从 DSH 凭据文件里读取 `refs.<ref>`。
 * @returns {{ ok:true, value:string, file:string, ref:string } | { ok:false, reason:string, file:string, ref:string }}
 */
export function readCredentialRef(ref, file = defaultCredentialsFile()) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    return { ok: false, reason: `凭据文件不可读：${redactText(err.message)}`, file, ref }
  }
  const lines = text.split(/\r?\n/)
  let inRefs = false
  let refsIndent = -1
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    const m = /^(\s*)([^:\s][^:]*)\s*:\s*(.*)$/.exec(line)
    if (!m) continue
    const key = m[2].trim()
    const rawValue = m[3]
    if (!inRefs) {
      if (indent === 0 && key === 'refs') {
        inRefs = true
        refsIndent = indent
      }
      continue
    }
    if (indent <= refsIndent) {
      // 离开 refs 段
      inRefs = false
      continue
    }
    if (key === ref) {
      const value = unquote(rawValue)
      if (!value) return { ok: false, reason: `refs.${ref} 存在但为空`, file, ref }
      return { ok: true, value, file, ref }
    }
  }
  return { ok: false, reason: `凭据文件里没有 refs.${ref}`, file, ref }
}

// ---------------------------------------------------------------------------
// URL 校验（与 SPEC §7.3 一致：只允许 http/https，不接受 userinfo）
// ---------------------------------------------------------------------------

export function normalizeBaseUrl(raw) {
  const s = String(raw ?? '').trim()
  if (!s) throw new Error('baseUrl 为空')
  let u
  try {
    u = new URL(s)
  } catch {
    throw new Error(`baseUrl 不是合法 URL：${redactText(s)}`)
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`baseUrl 协议不被允许：${u.protocol}`)
  }
  if (u.username || u.password) throw new Error('baseUrl 不允许携带 userinfo')
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/** 只暴露白名单响应头，避免把站点内部细节无序带出。 */
function pickHeaders(headers) {
  const keys = ['content-type', 'content-encoding', 'x-new-api-version', 'content-length', 'server']
  const out = {}
  for (const k of keys) {
    const v = headers.get(k)
    if (v != null) out[k] = v
  }
  return out
}

/**
 * 发起一次探测。**永不抛出**，所有失败都转成结构化的 { error }。
 * @returns {Promise<object>} probe 记录（已脱敏）
 */
export async function probe({
  name,
  baseUrl,
  urlPath,
  method = 'GET',
  headers = {},
  expectStatus = 200,
  timeoutMs = 15000,
  fetchImpl = globalThis.fetch,
  note,
}) {
  const url = `${baseUrl}${urlPath}`
  const started = Date.now()
  const record = {
    name,
    method,
    path: urlPath,
    url,
    expectedStatus: expectStatus,
    requestHeaders: Object.keys(headers), // 只暴露名字，绝不暴露值
    note,
  }
  let res
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      res = await fetchImpl(url, { method, headers, signal: controller.signal, redirect: 'manual' })
    } finally {
      clearTimeout(timer)
    }
  } catch (err) {
    const aborted = err?.name === 'AbortError'
    record.durationMs = Date.now() - started
    record.httpStatus = null
    record.ok = false
    record.error = aborted ? `TIMEOUT after ${timeoutMs}ms` : `NETWORK ${redactText(String(err?.message || err))}`
    return record
  }

  const bodyText = await res.text().catch(() => '')
  record.durationMs = Date.now() - started
  record.httpStatus = res.status
  record.responseHeaders = pickHeaders(res.headers)
  record.bodyBytes = Buffer.byteLength(bodyText, 'utf8')
  record.httpOk = res.status >= 200 && res.status < 300

  let parsed = null
  try {
    parsed = bodyText.length ? JSON.parse(bodyText) : null
  } catch {
    parsed = null
  }
  if (parsed !== null) {
    record.json = redactDeep(parsed)
  } else {
    record.bodyPreview = bodyText.length
      ? redactText(bodyText.slice(0, 300))
      : '(empty body)'
  }
  record.statusMatched = res.status === expectStatus
  record.ok = record.statusMatched && (parsed !== null || bodyText.length === 0)
  return record
}

// ---------------------------------------------------------------------------
// 摘要（人类输出 / checks 用）
// ---------------------------------------------------------------------------

function pick(obj, keys) {
  const out = {}
  if (!obj || typeof obj !== 'object') return out
  for (const k of keys) if (k in obj) out[k] = obj[k]
  return out
}

export function summarizeStatus(json) {
  const d = json?.data
  if (!d || typeof d !== 'object') return null
  return pick(d, [
    'version',
    'system_name',
    'price',
    'quota_per_unit',
    'usd_exchange_rate',
    'display_in_currency',
    'quota_display_type',
    'custom_currency_symbol',
    'custom_currency_exchange_rate',
    'server_address',
    'start_time',
  ])
}

export function summarizeSubscription(json) {
  if (!json || typeof json !== 'object') return null
  const s = pick(json, ['object', 'has_payment_method', 'soft_limit_usd', 'hard_limit_usd', 'system_hard_limit_usd', 'access_until'])
  if (typeof s.hard_limit_usd === 'number') {
    s.hardLimitIsUnlimitedSentinel = s.hard_limit_usd >= UNLIMITED_SENTINEL
  }
  return s
}

export function summarizeUsage(json) {
  if (!json || typeof json !== 'object') return null
  const s = pick(json, ['object', 'total_usage'])
  if (typeof s.total_usage === 'number') {
    s.total_usage_unit = 'USD cents'
    s.total_usage_usd = s.total_usage / 100
  }
  return s
}

export function summarizeSelf(json) {
  const d = json?.data
  if (!d || typeof d !== 'object') return null
  return pick(d, [
    'id',
    'username',
    'display_name',
    'quota',
    'used_quota',
    'remain_quota',
    'unlimited_quota',
    'request_count',
    'group',
    'status',
    'role',
  ])
}

export function summarizeModels(json) {
  const list = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : []
  return {
    count: list.length,
    ids: list.map((m) => (typeof m === 'string' ? m : m?.id)).filter(Boolean),
  }
}

// ---------------------------------------------------------------------------
// 主探测流程
// ---------------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {string} [opts.baseUrl]
 * @param {string} [opts.ref]
 * @param {string} [opts.credentialsFile]
 * @param {string} [opts.apiKey]        直接给 key（测试用；默认从凭据文件读）
 * @param {string} [opts.accessToken]   native 模式用户系统访问令牌（可选）
 * @param {number} [opts.timeoutMs]
 * @param {Function} [opts.fetchImpl]
 */
export async function runProbe(opts = {}) {
  const baseUrl = normalizeBaseUrl(opts.baseUrl || DEFAULT_BASE_URL)
  const ref = opts.ref || 'PI_API_KEY'
  const credentialsFile = opts.credentialsFile || defaultCredentialsFile()
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : 15000
  const fetchImpl = opts.fetchImpl || globalThis.fetch

  const startedAt = new Date().toISOString()
  const t0 = Date.now()

  let apiKey = typeof opts.apiKey === 'string' && opts.apiKey ? opts.apiKey : null
  let credential = { present: false, ref, file: credentialsFile, source: null, redacted: '(none)' }
  if (apiKey) {
    credential = { present: true, ref, file: null, source: 'argument', redacted: maskSecret(apiKey), length: apiKey.length }
  } else {
    const got = readCredentialRef(ref, credentialsFile)
    if (got.ok) {
      apiKey = got.value
      credential = {
        present: true,
        ref,
        file: credentialsFile,
        source: 'credentials-file',
        redacted: maskSecret(apiKey),
        length: apiKey.length,
      }
    } else {
      credential = { present: false, ref, file: credentialsFile, source: null, redacted: '(none)', reason: got.reason }
    }
  }

  const results = {}
  const now = () => new Date().toISOString()

  // 1) /api/status —— 公开
  results.status = await probe({ name: 'api/status', baseUrl, urlPath: '/api/status', expectStatus: 200, timeoutMs, fetchImpl })
  results.status.summary = summarizeStatus(results.status.json)

  // 2) /v1/models —— 需要 sk- 渠道 key
  if (apiKey) {
    results.models = await probe({
      name: 'v1/models',
      baseUrl,
      urlPath: '/v1/models',
      headers: { Authorization: `Bearer ${apiKey}` },
      expectStatus: 200,
      timeoutMs,
      fetchImpl,
      note: 'Bearer <sk- 渠道 key>',
    })
    results.models.summary = summarizeModels(results.models.json)
  } else {
    results.models = { name: 'v1/models', ok: false, skipped: true, error: 'SKIPPED: 没有可用的 sk- 渠道 key' }
  }

  // 3) compat 模式：billing subscription / usage
  if (apiKey) {
    results.billingSubscription = await probe({
      name: 'v1/dashboard/billing/subscription',
      baseUrl,
      urlPath: '/v1/dashboard/billing/subscription',
      headers: { Authorization: `Bearer ${apiKey}` },
      expectStatus: 200,
      timeoutMs,
      fetchImpl,
      note: 'Bearer <sk- 渠道 key>；OpenAI 兼容计费接口',
    })
    results.billingSubscription.summary = summarizeSubscription(results.billingSubscription.json)

    const y = new Date().getUTCFullYear()
    const usagePath = `/v1/dashboard/billing/usage?start_date=${y}-01-01&end_date=${y}-12-31`
    results.billingUsage = await probe({
      name: 'v1/dashboard/billing/usage',
      baseUrl,
      urlPath: usagePath,
      headers: { Authorization: `Bearer ${apiKey}` },
      expectStatus: 200,
      timeoutMs,
      fetchImpl,
      note: 'total_usage 单位 = USD 美分',
    })
    results.billingUsage.summary = summarizeUsage(results.billingUsage.json)
  } else {
    results.billingSubscription = { name: 'v1/dashboard/billing/subscription', ok: false, skipped: true, error: 'SKIPPED: 没有可用的 sk- 渠道 key' }
    results.billingUsage = { name: 'v1/dashboard/billing/usage', ok: false, skipped: true, error: 'SKIPPED: 没有可用的 sk- 渠道 key' }
  }

  // 4) /api/user/self —— 无令牌：**期望 401**
  results.userSelfNoToken = await probe({
    name: 'api/user/self (无凭据)',
    baseUrl,
    urlPath: '/api/user/self',
    expectStatus: 401,
    timeoutMs,
    fetchImpl,
    note: '期望 401：该接口只认用户系统访问令牌，不认 sk- 渠道 key',
  })
  results.userSelfNoToken.summary = summarizeSelf(results.userSelfNoToken.json)

  // 5) /api/user/self —— 坏令牌：**期望 401**
  results.userSelfBadToken = await probe({
    name: 'api/user/self (坏令牌)',
    baseUrl,
    urlPath: '/api/user/self',
    headers: { Authorization: 'Bearer sk-0000000000000000000000000000000000000000' },
    expectStatus: 401,
    timeoutMs,
    fetchImpl,
    note: '期望 401：伪造 access token',
  })
  results.userSelfBadToken.summary = summarizeSelf(results.userSelfBadToken.json)

  // 6) /api/user/self —— 用真实 sk- key 当 Bearer（compat 凭据误用探测）
  if (apiKey) {
    results.userSelfWithSkKey = await probe({
      name: 'api/user/self (Bearer sk- 渠道 key)',
      baseUrl,
      urlPath: '/api/user/self',
      headers: { Authorization: `Bearer ${apiKey}` },
      expectStatus: 401,
      timeoutMs,
      fetchImpl,
      note: '期望 401：证明 native 模式必须用用户系统访问令牌，sk- key 无效',
    })
    results.userSelfWithSkKey.summary = summarizeSelf(results.userSelfWithSkKey.json)
  }

  // 7) native 模式（可选，需要用户系统访问令牌）
  if (opts.accessToken) {
    results.userSelfAccessToken = await probe({
      name: 'api/user/self (用户系统访问令牌)',
      baseUrl,
      urlPath: '/api/user/self',
      headers: { Authorization: `Bearer ${opts.accessToken}` },
      expectStatus: 200,
      timeoutMs,
      fetchImpl,
      note: 'native 模式；如上游要求 userId，可另加 New-Api-User 头（见 docs/PROTOCOL.md）',
    })
    results.userSelfAccessToken.summary = summarizeSelf(results.userSelfAccessToken.json)
    results.userSelfAccessTokenNoUserHeader = results.userSelfAccessToken
  } else {
    results.userSelfAccessToken = {
      name: 'api/user/self (用户系统访问令牌)',
      ok: false,
      skipped: true,
      error: 'SKIPPED: 未提供 --access-token / NEWAPI_ACCESS_TOKEN（本机只有 sk- 渠道 key）',
    }
  }

  const checks = buildChecks(results, { credential })

  return {
    schema: PROBE_SCHEMA,
    baseUrl,
    startedAt,
    finishedAt: now(),
    durationMs: Date.now() - t0,
    credential,
    probes: results,
    checks,
    ok: checks.every((c) => !c.required || c.ok),
    notes: [
      '/api/status 与 /v1/models 不需要凭据（无令牌也返回 200）。',
      '/v1/dashboard/billing/* 使用 Bearer <sk- 渠道 key>，是 compat 模式的取数来源。',
      '/api/user/self 只认用户系统访问令牌；sk- 渠道 key 一律 401（native 模式不可用）。',
      'total_usage 的单位是 USD 美分（除以 100 得美元）。',
    ],
  }
}

export function buildChecks(results, { credential } = {}) {
  const checks = []
  const add = (id, ok, required, detail) => checks.push({ id, ok: !!ok, required: !!required, detail })

  add(
    'C1 status public 200',
    results.status?.httpStatus === 200 && results.status?.json?.success === true,
    true,
    `HTTP ${results.status?.httpStatus ?? 'n/a'}, success=${results.status?.json?.success}`,
  )
  add(
    'C2 status exposes quota_per_unit/usd_exchange_rate',
    typeof results.status?.summary?.quota_per_unit === 'number' && typeof results.status?.summary?.usd_exchange_rate === 'number',
    true,
    `quota_per_unit=${results.status?.summary?.quota_per_unit}, usd_exchange_rate=${results.status?.summary?.usd_exchange_rate}`,
  )
  add(
    'C3 credential present',
    credential?.present === true,
    true,
    credential?.present ? `${credential.source} ref=${credential.ref} ${credential.redacted}` : `缺失：${credential?.reason || 'unknown'}`,
  )
  add('C4 models 200', results.models?.httpStatus === 200, true, `HTTP ${results.models?.httpStatus ?? 'n/a'}, count=${results.models?.summary?.count ?? 'n/a'}`)
  add(
    'C5 billing subscription 200',
    results.billingSubscription?.httpStatus === 200,
    true,
    `HTTP ${results.billingSubscription?.httpStatus ?? 'n/a'}, hard_limit_usd=${results.billingSubscription?.summary?.hard_limit_usd ?? 'n/a'}`,
  )
  add(
    'C6 billing usage 200',
    results.billingUsage?.httpStatus === 200,
    true,
    `HTTP ${results.billingUsage?.httpStatus ?? 'n/a'}, total_usage=${results.billingUsage?.summary?.total_usage ?? 'n/a'} (cents)`,
  )
  add(
    'C7 /api/user/self 无凭据 = 401',
    results.userSelfNoToken?.httpStatus === 401,
    true,
    `HTTP ${results.userSelfNoToken?.httpStatus ?? 'n/a'}（期望 401）`,
  )
  add(
    'C8 /api/user/self 坏令牌 = 401',
    results.userSelfBadToken?.httpStatus === 401,
    true,
    `HTTP ${results.userSelfBadToken?.httpStatus ?? 'n/a'}（期望 401）`,
  )
  if (results.userSelfWithSkKey) {
    add(
      'C9 /api/user/self 用 sk- 渠道 key = 401',
      results.userSelfWithSkKey.httpStatus === 401,
      true,
      `HTTP ${results.userSelfWithSkKey.httpStatus}（期望 401 → native 模式必须用用户系统访问令牌）`,
    )
  }
  add(
    'C10 无输出泄露密钥',
    !JSON.stringify(results).match(/sk-[A-Za-z0-9_-]{6,}/),
    true,
    '所有响应均已递归脱敏',
  )
  return checks
}

// ---------------------------------------------------------------------------
// 日期窗口检查：证明上游忽略 start_date / end_date
// ---------------------------------------------------------------------------

/**
 * 用 4 个差异极大的窗口 + 无参数请求 billing/usage，比较 `total_usage` 是否完全相同。
 * 若完全相同 → 说明上游不按窗口过滤，`total_usage` 是**累计值**。
 *
 * @returns {{ baseUrl, credential, samples: Array, allEqual: boolean, note: string, ok: boolean }}
 */
export async function runWindowCheck(opts = {}) {
  const baseUrl = normalizeBaseUrl(opts.baseUrl || DEFAULT_BASE_URL)
  const ref = opts.ref || 'PI_API_KEY'
  const credentialsFile = opts.credentialsFile || defaultCredentialsFile()
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : 15000
  const fetchImpl = opts.fetchImpl || globalThis.fetch

  let apiKey = typeof opts.apiKey === 'string' && opts.apiKey ? opts.apiKey : null
  let credential = { present: false, ref, redacted: '(none)' }
  if (apiKey) {
    credential = { present: true, ref, source: 'argument', redacted: maskSecret(apiKey), length: apiKey.length }
  } else {
    const got = readCredentialRef(ref, credentialsFile)
    if (got.ok) {
      apiKey = got.value
      credential = { present: true, ref, source: 'credentials-file', redacted: maskSecret(apiKey), length: apiKey.length }
    } else {
      credential = { present: false, ref, redacted: '(none)', reason: got.reason }
    }
  }

  const windows = ['2026-01-01', '1970-01-01', '2099-12-31', '2026-10-04', null]
  const samples = []
  for (const w of windows) {
    const path = w
      ? `/v1/dashboard/billing/usage?start_date=${w}&end_date=${w}`
      : '/v1/dashboard/billing/usage'
    const r = await probe({
      name: `window=${w ?? '(none)'}`,
      baseUrl,
      urlPath: path,
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      expectStatus: 200,
      timeoutMs,
      fetchImpl,
    })
    samples.push({
      window: w,
      path,
      httpStatus: r.httpStatus,
      totalUsage: typeof r.json?.total_usage === 'number' ? r.json.total_usage : null,
      error: r.error ?? null,
    })
  }

  const values = samples.map((s) => s.totalUsage)
  const allEqual =
    values.length > 0 && values.every((v) => v !== null) && values.every((v) => v === values[0])

  return {
    schema: `${PROBE_SCHEMA}#window-check`,
    baseUrl,
    checkedAt: new Date().toISOString(),
    credential,
    samples,
    allEqual,
    note: allEqual
      ? '所有窗口（含无参数）返回同一个 total_usage → 上游忽略 start_date/end_date，该值是**累计已用**（不是窗口用量）。'
      : '不同窗口返回不同 total_usage → 上游按窗口过滤（本机未观测到该行为，请复核上游版本）。',
    ok: allEqual,
  }
}

// ---------------------------------------------------------------------------
// fixture 导出
// ---------------------------------------------------------------------------

/**
 * 由探测结果生成脱敏 fixture。
 *
 * 设计：fixture 文件**只含响应体本身**（键名/结构/数值与真实响应一致，仅 sk-… 被脱敏），
 * 溯源信息统一放在 `provenance.json`，这样 core/verify 的离线单测可以直接
 * `JSON.parse(readFileSync('fixtures/status.json'))` 当作真实响应使用，无需剥壳。
 *
 * `user-self.json` 在本机无法取得成功响应（只有 sk- 渠道 key，一律 401），因此
 * 按上游 v1.0.0-rc.40 `controller/user.go:buildSelfUserData` 的字段形状**构造**，
 * 并在 `provenance.json` 里标记 `constructed: true`。
 *
 * @returns {{ files: Record<string, unknown>, provenance: object }}
 */
export function buildFixtures(report, { now = new Date().toISOString() } = {}) {
  const p = report.probes
  const files = {}
  const provenance = {
    _provenance: {
      generator: 'test/probe-relay.mjs',
      schema: PROBE_SCHEMA,
      capturedAt: now,
      baseUrl: report.baseUrl,
      upstreamVersion: p.status?.summary?.version ?? null,
      sanitization: '所有形如 sk-… 的字符串已替换为 sk-***len=N；其余键名、结构与数值保持原样',
      legend: {
        real: '响应体直接来自本机中转站实测（已脱敏）',
        constructed: '本机无法取得该成功响应，按上游源码字段形状构造',
      },
    },
    files: {},
  }
  const declare = (name, info) => {
    provenance.files[name] = info
  }

  if (p.status?.json) {
    files['status.json'] = redactDeep(p.status.json)
    declare('status.json', {
      endpoint: 'GET /api/status',
      real: true,
      constructed: false,
      httpStatus: p.status.httpStatus,
      note: '公开接口，无需凭据。含站点全部公开配置（含公开站点域名 server_address / passkey_rp_id）。',
    })
  }
  if (p.models?.json) {
    files['models.json'] = redactDeep(p.models.json)
    declare('models.json', {
      endpoint: 'GET /v1/models',
      real: true,
      constructed: false,
      httpStatus: p.models.httpStatus,
      note: 'Bearer <sk- 渠道 key>。用于校验挂件条目 matchIds。',
    })
  }
  if (p.billingSubscription?.json) {
    files['billing-subscription.json'] = redactDeep(p.billingSubscription.json)
    declare('billing-subscription.json', {
      endpoint: 'GET /v1/dashboard/billing/subscription',
      real: true,
      constructed: false,
      httpStatus: p.billingSubscription.httpStatus,
      note: 'hard_limit_usd=100000000 是上游 controller/billing.go:56-58 的"无限额度"哨兵值。',
    })
  }
  if (p.billingUsage?.json) {
    files['billing-usage.json'] = redactDeep(p.billingUsage.json)
    declare('billing-usage.json', {
      endpoint: 'GET /v1/dashboard/billing/usage?start_date=<Y>-01-01&end_date=<Y>-12-31',
      real: true,
      constructed: false,
      httpStatus: p.billingUsage.httpStatus,
      note: 'total_usage 单位 = USD 美分（controller/billing.go:104 的 amount*100）。数值随真实用量变化。',
    })
  }
  if (p.userSelfNoToken?.json) {
    files['user-self-unauthorized.json'] = redactDeep(p.userSelfNoToken.json)
    declare('user-self-unauthorized.json', {
      endpoint: 'GET /api/user/self （无 Authorization 头）',
      real: true,
      constructed: false,
      httpStatus: p.userSelfNoToken.httpStatus,
      note: '真实 401 响应体：{"code":"AUTH_UNAUTHORIZED",...}（middleware/auth.go:227-229）。',
    })
  }

  // user-self.json：构造的成功形态，字段严格取自 controller/user.go:buildSelfUserData (rc.40)
  const statusSummary = p.status?.summary || {}
  const quotaPerUnit = typeof statusSummary.quota_per_unit === 'number' ? statusSummary.quota_per_unit : 500000
  const usedCents = typeof p.billingUsage?.json?.total_usage === 'number' ? p.billingUsage.json.total_usage : 1850.63
  const usedQuota = Math.round((usedCents / 100) * quotaPerUnit) // 与 billing-usage.json 自洽
  const remainingQuota = Math.round(50 * quotaPerUnit) // 示例：剩余 $50
  files['user-self.json'] = {
    success: true,
    message: '',
    data: {
      id: 1,
      username: 'example-user',
      display_name: 'example-user',
      has_password: true,
      role: 1,
      status: 1,
      email: '',
      github_id: '',
      discord_id: '',
      oidc_id: '',
      wechat_id: '',
      telegram_id: '',
      group: 'default',
      quota: remainingQuota,
      used_quota: usedQuota,
      request_count: 1234,
      aff_code: 'AAAA0000',
      aff_count: 0,
      aff_quota: 0,
      aff_history_quota: 0,
      inviter_id: 0,
      linux_do_id: '',
      setting: '{}',
      stripe_customer: '',
      sidebar_modules: '{}',
      permissions: { sidebar_settings: true, sidebar_modules: {} },
    },
  }
  declare('user-self.json', {
    endpoint: 'GET /api/user/self （Authorization: Bearer <用户系统访问令牌>）',
    real: false,
    constructed: true,
    httpStatus: 200,
    note:
      '本机只有 sk- 渠道 key，该接口一律 401，无法取得真实成功响应。' +
      '此文件按上游 v1.0.0-rc.40 controller/user.go:491-523 buildSelfUserData 的字段形状构造；' +
      'quota/used_quota 与 billing-usage.json 自洽（used_quota = round(total_usage/100 × quota_per_unit)）。' +
      '注意：rc.40 的 DTO 中**没有** unlimited_quota / remain_quota / access_token 字段。',
  })

  // ---- 以下是**构造**的变体，用于 core/verify 覆盖离线分支（provenance 明确标 constructed）----

  // 非哨兵形态的 subscription（同一 tag 的 controller/billing.go:41-66 逻辑：非 unlimited 时
  // amount = (RemainQuota+UsedQuota)/QuotaPerUnit）。数值与 user-self.json 自洽。
  const totalQuota = remainingQuota + usedQuota
  const finiteTotal = totalQuota / quotaPerUnit
  files['billing-subscription-finite.json'] = {
    object: 'billing_subscription',
    has_payment_method: true,
    soft_limit_usd: finiteTotal,
    hard_limit_usd: finiteTotal,
    system_hard_limit_usd: finiteTotal,
    access_until: 0,
  }
  declare('billing-subscription-finite.json', {
    endpoint: 'GET /v1/dashboard/billing/subscription（非 unlimited token 形态）',
    real: false,
    constructed: true,
    httpStatus: 200,
    note:
      '本机 token 是 unlimited，永远拿不到非哨兵形态。此文件按 controller/billing.go:41-66 计算构造，' +
      `与 user-self.json 自洽：hard_limit_usd = (quota+used_quota)/quota_per_unit = ${finiteTotal}。` +
      '用于覆盖 normalizeBalance 的"total 有限、remaining = total - used"分支。',
  })

  // native 的 unlimited 形态：字段在 rc.40 不存在，仅用于覆盖 normalizeBalance 的 unlimited 分支
  files['user-self-unlimited.json'] = {
    success: true,
    message: '',
    data: {
      id: 1,
      username: 'example-unlimited',
      display_name: 'example-unlimited',
      role: 1,
      status: 1,
      group: 'default',
      quota: 0,
      used_quota: usedQuota,
      request_count: 12,
      unlimited_quota: true,
      remain_quota: 0,
    },
  }
  declare('user-self-unlimited.json', {
    endpoint: 'GET /api/user/self（unlimited 形态）',
    real: false,
    constructed: true,
    httpStatus: 200,
    note:
      '⚠️ 上游 v1.0.0-rc.40 的 buildSelfUserData（controller/user.go:491-523）**不返回** unlimited_quota/remain_quota，' +
      '本机也无法取得该响应。此文件是**为覆盖 SPEC §5.1.1 的 unlimited 分支而人为构造**的输入，' +
      '不代表任何真实站点行为；只能当纯函数输入用。',
  })

  // 非 JSON 响应（网关/反代错误页）：**构造**，用于覆盖 NON_JSON 分支。
  // 写成 .html 原文（不 JSON 转义），因为真实场景里客户端拿到的就是这段 HTML。
  files['error-non-json.html'] =
    '<!doctype html>\n<html><head><title>502 Bad Gateway</title></head>\n' +
    '<body><center><h1>502 Bad Gateway</h1></center><hr><center>nginx</center></body></html>\n'
  declare('error-non-json.html', {
    endpoint: '（构造）任意上游返回 text/html 的场景',
    real: false,
    constructed: true,
    httpStatus: 502,
    note:
      '**构造**样本：本机中转站实测全部返回 application/json，没有真实 HTML 错误页可采。' +
      '此文件是反代/网关 502 页的典型形态，供 NON_JSON 分支单测使用（示例 HTTP 502 + text/html）。',
  })

  return { files, provenance }
}

export function writeFixtures(fixtures, dir = FIXTURES_DIR, provenance = null) {
  fs.mkdirSync(dir, { recursive: true })
  const written = []
  for (const [name, value] of Object.entries(fixtures)) {
    const target = path.join(dir, name)
    // .html/.txt 按原文写（模拟真实非 JSON 响应体），其余按 JSON 写
    const body =
      typeof value === 'string' && /\.(html|txt)$/i.test(name)
        ? value
        : `${JSON.stringify(value, null, 2)}\n`
    fs.writeFileSync(target, body, 'utf8')
    written.push(target)
  }
  if (provenance) {
    const target = path.join(dir, 'provenance.json')
    fs.writeFileSync(target, `${JSON.stringify(provenance, null, 2)}\n`, 'utf8')
    written.push(target)
  }
  return written
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

function fmt(v) {
  if (v === undefined) return 'undefined'
  if (v === null) return 'null'
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

export function renderHuman(report) {
  const L = []
  L.push('=== dsh-whale-newapi-bridge 协议探测 ===')
  L.push(`baseUrl   : ${report.baseUrl}`)
  L.push(`startedAt : ${report.startedAt}  (${report.durationMs}ms)`)
  L.push(
    `credential: ${report.credential.present ? `${report.credential.redacted} (${report.credential.source}, ref=${report.credential.ref})` : `缺失 — ${report.credential.reason || ''}`}`,
  )
  L.push('')
  const order = [
    'status',
    'models',
    'billingSubscription',
    'billingUsage',
    'userSelfNoToken',
    'userSelfBadToken',
    'userSelfWithSkKey',
    'userSelfAccessToken',
  ]
  for (const key of order) {
    const r = report.probes[key]
    if (!r) continue
    const tag = r.skipped ? 'SKIP' : r.ok ? 'OK  ' : 'FAIL'
    L.push(`[${tag}] ${r.name}`)
    if (r.skipped) {
      L.push(`       ${r.error}`)
      L.push('')
      continue
    }
    L.push(`       ${r.method} ${r.path}  →  HTTP ${r.httpStatus}  (expect ${r.expectedStatus})  ${r.durationMs}ms  ${r.bodyBytes ?? 0}B`)
    if (r.responseHeaders?.['x-new-api-version']) L.push(`       X-New-Api-Version: ${r.responseHeaders['x-new-api-version']}`)
    if (r.error) L.push(`       error: ${r.error}`)
    if (r.summary && Object.keys(r.summary).length) {
      for (const [k, v] of Object.entries(r.summary)) L.push(`       ${k} = ${fmt(v)}`)
    } else if (r.json && typeof r.json === 'object') {
      L.push(`       body: ${JSON.stringify(r.json)}`)
    } else if (r.bodyPreview) {
      L.push(`       body: ${r.bodyPreview}`)
    }
    L.push('')
  }
  L.push('--- checks ---')
  for (const c of report.checks) {
    L.push(`${c.ok ? 'PASS' : 'FAIL'}${c.required ? '' : ' (optional)'}  ${c.id}  —  ${c.detail}`)
  }
  L.push('')
  L.push(`RESULT: ${report.ok ? 'ALL REQUIRED CHECKS PASSED' : 'SOME REQUIRED CHECKS FAILED'}`)
  return L.join('\n')
}

export function renderWindowCheck(report) {
  const L = []
  L.push('=== billing/usage 日期窗口检查（证明 total_usage 是否按窗口过滤）===')
  L.push(`baseUrl   : ${report.baseUrl}`)
  L.push(`credential: ${report.credential.present ? `${report.credential.redacted} (${report.credential.source})` : '缺失'}`)
  L.push('')
  for (const s of report.samples) {
    L.push(
      `window ${String(s.window ?? '(none)').padEnd(10)} → HTTP ${s.httpStatus}  total_usage = ${s.totalUsage === null ? '(n/a)' : s.totalUsage}${s.error ? `  error=${s.error}` : ''}`,
    )
  }
  L.push('')
  L.push(report.note)
  L.push(`RESULT: ${report.ok ? 'WINDOW IGNORED (cumulative)' : 'WINDOWS DIFFER (windowed)'}`)
  return L.join('\n')
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const opts = { json: false, writeFixtures: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    if (a === '--json') opts.json = true
    else if (a === '--write-fixtures') opts.writeFixtures = true
    else if (a === '--check-window') opts.checkWindow = true
    else if (a === '--base-url') opts.baseUrl = next()
    else if (a.startsWith('--base-url=')) opts.baseUrl = a.slice('--base-url='.length)
    else if (a === '--ref') opts.ref = next()
    else if (a.startsWith('--ref=')) opts.ref = a.slice('--ref='.length)
    else if (a === '--credentials-file') opts.credentialsFile = next()
    else if (a === '--access-token') opts.accessToken = next()
    else if (a === '--timeout-ms') opts.timeoutMs = Number(next())
    else if (a === '--help' || a === '-h') opts.help = true
    else if (a === '--list-fixtures') opts.listFixtures = true
    else {
      opts.unknown = a
      return opts
    }
  }
  if (!opts.accessToken && process.env.NEWAPI_ACCESS_TOKEN) opts.accessToken = process.env.NEWAPI_ACCESS_TOKEN
  return opts
}

const HELP = `dsh-whale-newapi-bridge 协议探测器

用法: node test/probe-relay.mjs [选项]

选项:
  --json                  仅向 stdout 输出 JSON（供测试复用）
  --base-url <url>        中转站地址（默认 ${DEFAULT_BASE_URL}）
  --ref <name>            凭据文件 refs 下的键名（默认 PI_API_KEY）
  --credentials-file <p>  凭据文件路径（默认 %USERPROFILE%\\.dsh\\.credentials.yaml）
  --access-token <tok>    可选：用户系统访问令牌，用于探测 native 模式
  --timeout-ms <n>        单请求超时（默认 15000）
  --write-fixtures        把脱敏响应写入 test/fixtures/
  --check-window          只做「日期窗口是否被忽略」检查（4 个窗口 + 无参数）
  -h, --help              显示本帮助

退出码: 0 全部必需检查通过 / 1 有必需检查失败 / 2 用法或配置错误
`

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    process.stdout.write(HELP)
    return 0
  }
  if (opts.unknown) {
    process.stderr.write(`未知参数：${opts.unknown}\n${HELP}`)
    return 2
  }

  // 单独的窗口检查模式：不跑全量探测
  if (opts.checkWindow) {
    let report
    try {
      report = await runWindowCheck(opts)
    } catch (err) {
      process.stderr.write(`窗口检查失败：${redactText(String(err?.message || err))}\n`)
      return 2
    }
    const out = opts.json ? JSON.stringify(report, null, 2) : renderWindowCheck(report)
    if (/sk-[A-Za-z0-9_-]{6,}/.test(out)) {
      process.stderr.write('内部错误：输出中检出未脱敏凭据，已中止输出。\n')
      return 2
    }
    process.stdout.write(`${out}\n`)
    return report.ok ? 0 : 1
  }

  let report
  try {
    report = await runProbe(opts)
  } catch (err) {
    process.stderr.write(`探测失败：${redactText(String(err?.message || err))}\n`)
    return 2
  }

  if (opts.writeFixtures) {
    const { files, provenance } = buildFixtures(report)
    const written = writeFixtures(files, FIXTURES_DIR, provenance)
    report.fixturesWritten = written
    if (!opts.json) {
      process.stdout.write(`已写入脱敏 fixture：\n${written.map((w) => `  - ${w}`).join('\n')}\n\n`)
    }
  }

  // 二次保险：确保 stdout 里绝不出现 sk- 明文
  const out = opts.json ? JSON.stringify(report, null, 2) : renderHuman(report)
  if (/sk-[A-Za-z0-9_-]{6,}/.test(out)) {
    process.stderr.write('内部错误：输出中检出未脱敏凭据，已中止输出。\n')
    return 2
  }
  process.stdout.write(`${out}\n`)
  return report.ok ? 0 : 1
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (invokedDirectly) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`未捕获错误：${redactText(String(err?.stack || err))}\n`)
      process.exit(2)
    },
  )
}
