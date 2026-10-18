/**
 * 配置默认值、归一化与 Loader 的 `Config` schema（SPEC §4）。
 *
 * `Config` 用 `@deepseek-ai/schemastery`（与 `dsh-better-sidebar` /
 * `dsh-plugin-wallpaper-engine` 同款）构建，但**解析是容错的**：
 * - 已安装进 profile 时，裸 specifier `@deepseek-ai/schemastery` 一定能解析
 *   （包就在 profile 的 node_modules 里）；
 * - 直接在工作区里 import 本模块时（开发/自测），裸 specifier 解析不到，
 *   于是回退到从 `DSH_PROFILE_DIR` / `DSH_HOME` / `~/.dsh/profiles/*` 里
 *   找到已安装的那份 schemastery —— 这样 `Config` 在两种上下文里都存在；
 * - 两种路径都失败时（SPEC §3 的降级条款）不导出 `Config`（undefined），
 *   `apply(ctx, config)` 的第二个参数仍然当普通对象用，功能不受影响。
 *
 * 所有归一化都**不抛异常**：非法值回退默认值并记一条中文 warning，
 * 由 `/status` 的 `warnings` 如实暴露（宿主绝不能被配置拖垮）。
 *
 * @module dsh-whale-newapi-bridge/config
 */

import { createRequire } from 'node:module'
import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { DEFAULT_BASE_URL, explainLoopbackBaseUrl, normalizeBaseUrl, normalizeLoopbackBaseUrl } from './newapi.mjs'

/** 插件版本（与 package.json 保持一致；`/health` 与 `/status` 都会报它）。 */
export const PLUGIN_VERSION = '0.1.1'

/** 凭据名（credentialRef）允许的字符集：DSH 凭据只允许字母/数字/下划线。 */
const REF_PATTERN = /^[A-Za-z0-9_]+$/

/** `.dshw-api.json` 条目 id 允许的字符集（SPEC §4）。 */
const MODEL_ID_PATTERN = /^[A-Za-z0-9_-]+$/

/** SPEC §4 的默认配置（唯一来源）。 */
export const DEFAULT_CONFIG = Object.freeze({
  baseUrl: DEFAULT_BASE_URL,
  credentialRef: 'NEWAPI_RELAY_TOKEN',
  credentialCandidates: Object.freeze(['NEWAPI_RELAY_TOKEN', 'NEWAPI_API_KEY', 'PI_API_KEY']),
  authMode: 'auto',
  userId: '',
  modelId: 'newapi_relay',
  modelName: '团队中转站',
  currency: 'CNY',
  usdToCny: 0,
  quotaPerUnit: 0,
  fallbackTotal: 0,
  bridgeBaseUrl: '',
  autoSync: true,
  syncIntervalSeconds: 300,
  requestTimeoutMs: 15000,
  enabled: true,
})

const SYNC_INTERVAL_MIN = 5
const SYNC_INTERVAL_MAX = 86400
const TIMEOUT_MIN = 1000
const TIMEOUT_MAX = 120000

// ── schemastery 解析（容错） ─────────────────────────────────────────────────

function tryRequireSchemastery(baseFile) {
  try {
    const mod = createRequire(baseFile)('@deepseek-ai/schemastery')
    const z = mod && mod.default !== undefined ? mod.default : mod
    if (z && typeof z.object === 'function') return z
  } catch {
    /* 解析不到就换下一个候选目录 */
  }
  return undefined
}

function candidateProfileDirs() {
  const dirs = []
  const push = (dir) => {
    if (typeof dir === 'string' && dir.trim() !== '' && !dirs.includes(dir)) dirs.push(dir)
  }
  if (process.env.DSH_PROFILE_DIR) push(path.resolve(process.env.DSH_PROFILE_DIR))
  const dshHome = process.env.DSH_HOME ? path.resolve(process.env.DSH_HOME) : path.join(os.homedir(), '.dsh')
  push(path.join(dshHome, 'profiles', process.env.DSH_PROFILE || 'desktop'))
  push(path.join(dshHome, 'profiles', 'desktop'))
  push(dshHome)
  try {
    const root = path.join(dshHome, 'profiles')
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory()) push(path.join(root, entry.name))
    }
  } catch {
    /* profiles 目录不存在就算了 */
  }
  return dirs.filter((dir) => {
    try {
      return statSync(dir).isDirectory()
    } catch {
      return false
    }
  })
}

/**
 * 找到一份可用的 `@deepseek-ai/schemastery`。
 *
 * @returns `{ z, source }`；两种路径都失败时 `source === null`、`z === undefined`。
 */
function resolveSchemastery() {
  const bare = tryRequireSchemastery(import.meta.url)
  if (bare !== undefined) return { z: bare, source: 'bare:@deepseek-ai/schemastery' }
  for (const dir of candidateProfileDirs()) {
    const z = tryRequireSchemastery(path.join(dir, '__dsh_resolve_probe.cjs'))
    if (z !== undefined) return { z, source: `profile:${dir}` }
  }
  return { z: undefined, source: null }
}

const schemastery = resolveSchemastery()

/** `Config` 到底从哪儿来的（`null` = 降级为不导出 Config）；写进 `/status` 便于诊断。 */
export const SCHEMASTERMY_SOURCE = schemastery.source

/**
 * 用给定的 schemastery 构建 §4 的 schema。
 *
 * @param z - schemastery 实例。
 * @returns Loader 用的 schema 对象。
 */
export function buildConfigSchema(z) {
  return z.object({
    baseUrl: z.string().default(DEFAULT_CONFIG.baseUrl),
    credentialRef: z.string().default(DEFAULT_CONFIG.credentialRef),
    credentialCandidates: z.array(z.string()).default([...DEFAULT_CONFIG.credentialCandidates]),
    authMode: z.union([z.const('auto'), z.const('native'), z.const('compat')]).default(DEFAULT_CONFIG.authMode),
    userId: z.string().default(DEFAULT_CONFIG.userId),
    modelId: z.string().default(DEFAULT_CONFIG.modelId),
    modelName: z.string().default(DEFAULT_CONFIG.modelName),
    currency: z.string().default(DEFAULT_CONFIG.currency),
    usdToCny: z.number().default(DEFAULT_CONFIG.usdToCny),
    quotaPerUnit: z.number().default(DEFAULT_CONFIG.quotaPerUnit),
    fallbackTotal: z.number().default(DEFAULT_CONFIG.fallbackTotal),
    bridgeBaseUrl: z.string().default(DEFAULT_CONFIG.bridgeBaseUrl),
    autoSync: z.boolean().default(DEFAULT_CONFIG.autoSync),
    syncIntervalSeconds: z.number().default(DEFAULT_CONFIG.syncIntervalSeconds),
    requestTimeoutMs: z.number().default(DEFAULT_CONFIG.requestTimeoutMs),
    enabled: z.boolean().default(DEFAULT_CONFIG.enabled),
  })
}

/**
 * Loader 行 schema。解析不到 schemastery 时为 `undefined`
 * —— 此时**不导出** `Config`（SPEC §3 的降级条款）。
 */
export const Config = schemastery.z === undefined ? undefined : buildConfigSchema(schemastery.z)

// ── 归一化 ──────────────────────────────────────────────────────────────────

function asBool(value, fallback, key, warnings) {
  if (value === undefined) return fallback
  if (typeof value === 'boolean') return value
  warnings.push(`${key} 不是布尔值，已回退默认 ${fallback}`)
  return fallback
}

function asNumber(value, fallback, key, warnings, { min = -Infinity, max = Infinity } = {}) {
  if (value === undefined) return fallback
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) {
    warnings.push(`${key} 不是有限数值，已回退默认 ${fallback}`)
    return fallback
  }
  if (n < min) {
    warnings.push(`${key}=${n} 小于下限 ${min}，已收敛为 ${min}`)
    return min
  }
  if (n > max) {
    warnings.push(`${key}=${n} 大于上限 ${max}，已收敛为 ${max}`)
    return max
  }
  return n
}

function asString(value, fallback, key, warnings) {
  if (value === undefined) return fallback
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  warnings.push(`${key} 不是字符串，已回退默认 ${JSON.stringify(fallback)}`)
  return fallback
}

function asRef(value) {
  return typeof value === 'string' && REF_PATTERN.test(value) ? value : null
}

/**
 * 把用户/安装期给的配置归一化成完整配置对象（SPEC §4 全表）。
 * 不抛异常；非法值回退默认并记 warning。
 *
 * @param raw - Loader 传入的配置（可能缺项、可能是任意类型）。
 * @returns `{ config, warnings }`。
 */
export function normalizeConfig(raw) {
  const warnings = []
  const input = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
    warnings.push('config 不是对象，已整体回退默认值')
  }
  const config = { ...DEFAULT_CONFIG, credentialCandidates: [...DEFAULT_CONFIG.credentialCandidates] }

  // baseUrl：解析失败即回退默认（SPEC §7.3 不允许非法上游）
  if (input.baseUrl !== undefined) {
    try {
      config.baseUrl = normalizeBaseUrl(input.baseUrl)
    } catch (err) {
      warnings.push(`baseUrl 非法（${err.message}），已回退默认 ${DEFAULT_BASE_URL}`)
      config.baseUrl = DEFAULT_BASE_URL
    }
  } else {
    config.baseUrl = normalizeBaseUrl(DEFAULT_BASE_URL)
  }

  // credentialRef + credentialCandidates
  const ref = asRef(input.credentialRef)
  if (input.credentialRef !== undefined && ref === null) {
    warnings.push(`credentialRef 只允许 [A-Za-z0-9_]，已回退默认 ${DEFAULT_CONFIG.credentialRef}`)
  }
  config.credentialRef = ref ?? DEFAULT_CONFIG.credentialRef
  const candidates = []
  const rawCandidates = input.credentialCandidates
  if (rawCandidates !== undefined && !Array.isArray(rawCandidates)) {
    warnings.push('credentialCandidates 不是数组，已回退默认列表')
  }
  const list = Array.isArray(rawCandidates) ? rawCandidates : [...DEFAULT_CONFIG.credentialCandidates]
  if (Array.isArray(rawCandidates)) {
    for (const item of rawCandidates) {
      if (asRef(item) === null) warnings.push(`credentialCandidates 里的 ${JSON.stringify(item)} 不是合法凭据名，已忽略`)
    }
  }
  // credentialRef 恒排第一：它是「首选凭据」
  candidates.push(config.credentialRef)
  for (const item of list) {
    const value = asRef(item)
    if (value !== null && !candidates.includes(value)) candidates.push(value)
  }
  config.credentialCandidates = candidates

  // authMode
  const authMode = input.authMode
  if (authMode !== undefined && authMode !== 'auto' && authMode !== 'native' && authMode !== 'compat') {
    warnings.push(`authMode=${JSON.stringify(authMode)} 不是 auto/native/compat，已回退 auto`)
  }
  config.authMode = authMode === 'native' || authMode === 'compat' ? authMode : 'auto'

  config.userId = asString(input.userId, DEFAULT_CONFIG.userId, 'userId', warnings).trim()
  // New API 的用户 id 会被当 HTTP 头（`new-api-user`）发出去，控制字符会让 fetch 直接抛
  // TypeError（表现为难懂的 NETWORK 错误），所以在配置层就清掉。
  if (/[\u0000-\u001F\u007F]/.test(config.userId)) {
    warnings.push('userId 含控制字符（会构成非法 HTTP 头值），已清除')
    config.userId = config.userId.replace(/[\u0000-\u001F\u007F]/g, '')
  }

  // modelId（写进注册表的 id）
  const modelId = asString(input.modelId, DEFAULT_CONFIG.modelId, 'modelId', warnings).trim()
  if (!MODEL_ID_PATTERN.test(modelId)) {
    warnings.push(`modelId 只允许 [A-Za-z0-9_-]，已回退默认 ${DEFAULT_CONFIG.modelId}`)
    config.modelId = DEFAULT_CONFIG.modelId
  } else {
    config.modelId = modelId
  }

  const modelName = asString(input.modelName, DEFAULT_CONFIG.modelName, 'modelName', warnings).trim()
  config.modelName = modelName === '' ? DEFAULT_CONFIG.modelName : modelName

  // currency：只认 CNY/USD（normalizeBalance 的唯一输出口径）
  const currency = asString(input.currency, DEFAULT_CONFIG.currency, 'currency', warnings).trim().toUpperCase()
  if (currency !== 'CNY' && currency !== 'USD') {
    warnings.push(`currency=${JSON.stringify(input.currency)} 未支持（只支持 CNY/USD），已回退 CNY`)
    config.currency = 'CNY'
  } else {
    config.currency = currency
  }

  config.usdToCny = Math.max(0, asNumber(input.usdToCny, DEFAULT_CONFIG.usdToCny, 'usdToCny', warnings))
  config.quotaPerUnit = Math.max(0, asNumber(input.quotaPerUnit, DEFAULT_CONFIG.quotaPerUnit, 'quotaPerUnit', warnings))
  config.fallbackTotal = Math.max(0, asNumber(input.fallbackTotal, DEFAULT_CONFIG.fallbackTotal, 'fallbackTotal', warnings))

  // bridgeBaseUrl：空 = 自动探测（SPEC §6）；非空必须是回环 origin（SPEC §10.2）
  if (input.bridgeBaseUrl !== undefined && input.bridgeBaseUrl !== '') {
    const loopback = normalizeLoopbackBaseUrl(input.bridgeBaseUrl)
    if (loopback !== null) {
      config.bridgeBaseUrl = loopback
    } else {
      const reason = explainLoopbackBaseUrl(input.bridgeBaseUrl) ?? '不是回环 origin'
      warnings.push(`bridgeBaseUrl 已被忽略并改为自动探测（SPEC §10.2：只允许回环 origin；${reason}）`)
      config.bridgeBaseUrl = ''
    }
  } else {
    config.bridgeBaseUrl = ''
  }

  config.autoSync = asBool(input.autoSync, DEFAULT_CONFIG.autoSync, 'autoSync', warnings)
  config.enabled = asBool(input.enabled, DEFAULT_CONFIG.enabled, 'enabled', warnings)
  config.syncIntervalSeconds = asNumber(input.syncIntervalSeconds, DEFAULT_CONFIG.syncIntervalSeconds, 'syncIntervalSeconds', warnings, {
    min: SYNC_INTERVAL_MIN,
    max: SYNC_INTERVAL_MAX,
  })
  config.requestTimeoutMs = asNumber(input.requestTimeoutMs, DEFAULT_CONFIG.requestTimeoutMs, 'requestTimeoutMs', warnings, {
    min: TIMEOUT_MIN,
    max: TIMEOUT_MAX,
  })

  if (config.fallbackTotal > 0 && config.currency !== 'CNY' && config.usdToCny === 0) {
    warnings.push('fallbackTotal>0 但 currency=USD 且 usdToCny=0：fallbackTotal 视为 USD 口径')
  }

  return { config, warnings }
}

/**
 * `/status` 用的脱敏配置快照：只含 §4 的键，且不含任何凭据值（配置里本来就只有凭据名）。
 *
 * @param config - 归一化后的配置。
 * @returns 浅拷贝（数组也拷贝）。
 */
export function publicConfig(config) {
  const c = config !== null && typeof config === 'object' ? config : DEFAULT_CONFIG
  return {
    baseUrl: c.baseUrl,
    credentialRef: c.credentialRef,
    credentialCandidates: Array.isArray(c.credentialCandidates) ? [...c.credentialCandidates] : [],
    authMode: c.authMode,
    userId: c.userId === '' ? '' : '<set>',
    modelId: c.modelId,
    modelName: c.modelName,
    currency: c.currency,
    usdToCny: c.usdToCny,
    quotaPerUnit: c.quotaPerUnit,
    fallbackTotal: c.fallbackTotal,
    bridgeBaseUrl: c.bridgeBaseUrl,
    autoSync: c.autoSync,
    syncIntervalSeconds: c.syncIntervalSeconds,
    requestTimeoutMs: c.requestTimeoutMs,
    enabled: c.enabled,
  }
}
