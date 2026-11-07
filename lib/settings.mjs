/**
 * 设置文件持久化层（v0.2.0 新增，SPEC §4.7 / §6.5）。
 *
 * 设置页（client.js）保存的**覆盖项**写进 `$DSH_HOME/whale-newapi-bridge-settings.json`；
 * 宿主启动时先读它，再与 Loader 传入的 yml 配置合并（设置文件 > yml > 内置默认）。
 * 这里刻意不复用 config.mjs 的容错归一化：设置接口必须把非法输入**明确报错**
 * （400 + fields），而不是静默回退默认值——只有读取历史文件时才走「逐键校验、坏键丢弃」。
 *
 * 安全边界（SPEC §7.1）：
 * - 本文件永远只保存配置项本身，**绝不保存凭据明文**（凭据靠 credentialRef 名字解析）；
 * - 原子写：同目录临时文件 + rename，避免半截文件；
 * - 目录不存在时返回错误而**不自动创建**（符合 DSH 数据目录由宿主管理的约定）。
 *
 * @module dsh-whale-newapi-bridge/settings
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_CONFIG } from './config.mjs'
import { explainLoopbackBaseUrl, normalizeBaseUrl, normalizeLoopbackBaseUrl } from './newapi.mjs'

/** 设置文件名（放在 `$DSH_HOME` 根下，SPEC §4.7）。 */
export const SETTINGS_FILE = 'whale-newapi-bridge-settings.json'

/**
 * 可持久化的配置键，顺序与 {@link DEFAULT_CONFIG} 完全一致（16 项，SPEC §4）。
 * 设置文件里只出现这些键；未知键在读文件时丢弃、在保存时 400。
 */
export const PERSISTED_KEYS = Object.freeze(Object.keys(DEFAULT_CONFIG))

/** 凭据名允许的字符集（与 config.mjs / SPEC §4 一致）。 */
const REF_PATTERN = /^[A-Za-z0-9_]+$/
/** `.dshw-api.json` 条目 id 允许的字符集（SPEC §4）。 */
const MODEL_ID_PATTERN = /^[A-Za-z0-9_-]+$/
/** 控制字符（userId 不允许）。 */
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/
const SYNC_INTERVAL_MIN = 5
const SYNC_INTERVAL_MAX = 86400
const TIMEOUT_MIN = 1000
const TIMEOUT_MAX = 120000
const MODEL_NAME_MAX = 100
const AUTH_MODES = Object.freeze(['auto', 'native', 'compat'])
const CURRENCIES = Object.freeze(['CNY', 'USD'])

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function cloneJson(value) {
  if (Array.isArray(value)) return value.map(cloneJson)
  if (isPlainObject(value)) {
    const out = {}
    for (const key of Object.keys(value)) out[key] = cloneJson(value[key])
    return out
  }
  return value
}

function pathOf(file) {
  return typeof file === 'string' && file.trim() !== '' ? file : SETTINGS_FILE
}

/**
 * 解析设置文件绝对路径。
 *
 * 优先级：显式传入的 `dshHome` > `process.env.DSH_HOME` > `~/.dsh`。
 *
 * @param dshHome - 可选的 DSH 数据目录（测试/诊断用）。
 * @returns 设置文件绝对路径。
 */
export function resolveSettingsPath(dshHome) {
  let home = ''
  if (typeof dshHome === 'string' && dshHome.trim() !== '') {
    home = dshHome.trim()
  } else if (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== '') {
    home = process.env.DSH_HOME.trim()
  } else {
    home = path.join(os.homedir(), '.dsh')
  }
  return path.join(home, SETTINGS_FILE)
}

/**
 * 原子写设置文件（同目录临时文件 + rename）。
 *
 * @param file - 目标文件。
 * @param text - 完整文件内容（UTF-8）。
 * @returns `{ok:true,file}` 或 `{ok:false,error}`；目录不存在时**不**自动创建。
 */
export function atomicWriteSettings(file, text) {
  const target = pathOf(file)
  if (typeof text !== 'string') return { ok: false, error: '设置内容必须是字符串' }
  const dir = path.dirname(target)
  let stat
  try {
    stat = fs.statSync(dir)
  } catch (err) {
    return { ok: false, error: `设置目录不存在或不可访问：${dir}（${err && err.code ? err.code : err && err.message ? err.message : '未知错误'}）` }
  }
  if (stat.isDirectory() !== true) return { ok: false, error: `设置目录不是目录：${dir}` }
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
  try {
    fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(tmp, target)
    return { ok: true, file: target }
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      /* 临时文件清理失败不影响结果判断 */
    }
    return { ok: false, error: `设置文件写入失败：${err && err.code ? err.code : err && err.message ? err.message : '未知错误'}` }
  }
}

/**
 * 读取设置文件（容错，永不抛）。
 *
 * - 文件不存在（ENOENT）：`{ok:true,exists:false,values:{}}`，不产生 warning；
 * - 坏 JSON / 非对象：忽略整个文件并给 warning；
 * - 未知键：丢弃并给 warning；
 * - 已知键的值**原样保留**，合法性交给 {@link validateSettingsPatch} 逐键判定。
 *
 * @param file - 设置文件路径。
 * @returns `{ok, exists, values, warnings, error?}`。
 */
export function readSettingsFile(file) {
  const target = pathOf(file)
  const warnings = []
  let text
  try {
    text = fs.readFileSync(target, 'utf8')
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: true, exists: false, values: {}, warnings }
    const detail = err && err.code ? err.code : err && err.message ? err.message : '未知错误'
    warnings.push(`设置文件读取失败（${target}）：${detail}，已忽略`)
    return { ok: false, exists: false, values: {}, warnings, error: `读取设置文件失败：${detail}` }
  }
  let raw
  try {
    raw = JSON.parse(text)
  } catch (err) {
    warnings.push(`设置文件不是合法 JSON，已忽略整个文件（${target}）：${err && err.message ? err.message : '解析失败'}`)
    return { ok: true, exists: true, values: {}, warnings }
  }
  if (!isPlainObject(raw)) {
    warnings.push(`设置文件内容必须是 JSON 对象，已忽略整个文件（${target}）`)
    return { ok: true, exists: true, values: {}, warnings }
  }
  const values = {}
  const unknown = []
  for (const key of Object.keys(raw)) {
    if (!PERSISTED_KEYS.includes(key)) {
      unknown.push(key)
      continue
    }
    values[key] = cloneJson(raw[key])
  }
  if (unknown.length > 0) warnings.push(`设置文件里有未知键，已忽略（${target}）：${unknown.join(', ')}`)
  return { ok: true, exists: true, values, warnings }
}

/**
 * 逐键校验一份设置补丁（收集**全部**错误，不首错即停）。
 *
 * @param patch - 来自 POST /settings 的扁平对象。
 * @returns `{ok, patch, errors:[{key,message}]}`；ok 时 `patch` 是归一化后的值。
 */
export function validateSettingsPatch(patch) {
  const errors = []
  const out = {}
  if (!isPlainObject(patch)) {
    return { ok: false, patch: {}, errors: [{ key: '*', message: '设置补丁必须是扁平 JSON 对象' }] }
  }
  const fail = (key, message) => {
    errors.push({ key, message })
  }
  for (const key of Object.keys(patch)) {
    if (!PERSISTED_KEYS.includes(key)) {
      fail(key, `未知设置项（允许：${PERSISTED_KEYS.join(', ')}）`)
      continue
    }
    const value = patch[key]
    switch (key) {
      case 'baseUrl': {
        if (typeof value !== 'string' || value.trim() === '') {
          fail(key, 'baseUrl 必须是非空字符串')
          break
        }
        try {
          out.baseUrl = normalizeBaseUrl(value)
        } catch (err) {
          fail(key, `baseUrl 必须是 http/https 且不含 userinfo/query/hash：${err && err.message ? err.message : '不合法'}`)
        }
        break
      }
      case 'credentialRef': {
        if (typeof value !== 'string' || REF_PATTERN.test(value) !== true) {
          fail(key, 'credentialRef 只能包含字母/数字/下划线')
          break
        }
        out.credentialRef = value
        break
      }
      case 'credentialCandidates': {
        if (!Array.isArray(value)) {
          fail(key, 'credentialCandidates 必须是字符串数组')
          break
        }
        const seen = new Set()
        const list = []
        let bad = false
        value.forEach((item, index) => {
          if (typeof item !== 'string' || REF_PATTERN.test(item) !== true) {
            bad = true
            fail(key, `credentialCandidates[${index}] 只能包含字母/数字/下划线`)
            return
          }
          if (seen.has(item)) return
          seen.add(item)
          list.push(item)
        })
        if (!bad) out.credentialCandidates = list
        break
      }
      case 'authMode': {
        if (typeof value !== 'string' || !AUTH_MODES.includes(value)) {
          fail(key, `authMode 只能是 ${AUTH_MODES.join(' / ')}`)
          break
        }
        out.authMode = value
        break
      }
      case 'userId': {
        if (typeof value !== 'string') {
          fail(key, 'userId 必须是字符串')
          break
        }
        const trimmed = value.trim()
        if (CONTROL_CHARS.test(trimmed)) {
          fail(key, 'userId 不能包含控制字符')
          break
        }
        out.userId = trimmed
        break
      }
      case 'modelId': {
        if (typeof value !== 'string' || MODEL_ID_PATTERN.test(value.trim()) !== true) {
          fail(key, 'modelId 只能包含字母/数字/下划线/短横线')
          break
        }
        out.modelId = value.trim()
        break
      }
      case 'modelName': {
        if (typeof value !== 'string' || value.trim() === '') {
          fail(key, 'modelName 必须是非空字符串')
          break
        }
        const trimmed = value.trim()
        if (trimmed.length > MODEL_NAME_MAX) {
          fail(key, `modelName 不能超过 ${MODEL_NAME_MAX} 个字符`)
          break
        }
        out.modelName = trimmed
        break
      }
      case 'currency': {
        if (typeof value !== 'string' || !CURRENCIES.includes(value.trim().toUpperCase())) {
          fail(key, `currency 只能是 ${CURRENCIES.join(' / ')}`)
          break
        }
        out.currency = value.trim().toUpperCase()
        break
      }
      case 'usdToCny':
      case 'quotaPerUnit':
      case 'fallbackTotal': {
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
          fail(key, `${key} 必须是大于等于 0 的有限数字`)
          break
        }
        out[key] = value
        break
      }
      case 'bridgeBaseUrl': {
        if (typeof value !== 'string') {
          fail(key, 'bridgeBaseUrl 必须是字符串（留空表示自动探测）')
          break
        }
        const trimmed = value.trim()
        if (trimmed === '') {
          out.bridgeBaseUrl = ''
          break
        }
        const normalized = normalizeLoopbackBaseUrl(trimmed)
        if (normalized === null) {
          const reason = explainLoopbackBaseUrl(trimmed) ?? '不是本机回环地址'
          fail(key, `bridgeBaseUrl 只允许指向本机回环地址（${reason}）`)
          break
        }
        out.bridgeBaseUrl = normalized
        break
      }
      case 'syncIntervalSeconds': {
        if (typeof value !== 'number' || !Number.isInteger(value) || value < SYNC_INTERVAL_MIN || value > SYNC_INTERVAL_MAX) {
          fail(key, `syncIntervalSeconds 必须是 ${SYNC_INTERVAL_MIN}..${SYNC_INTERVAL_MAX} 的整数`)
          break
        }
        out.syncIntervalSeconds = value
        break
      }
      case 'requestTimeoutMs': {
        if (typeof value !== 'number' || !Number.isInteger(value) || value < TIMEOUT_MIN || value > TIMEOUT_MAX) {
          fail(key, `requestTimeoutMs 必须是 ${TIMEOUT_MIN}..${TIMEOUT_MAX} 的整数`)
          break
        }
        out.requestTimeoutMs = value
        break
      }
      case 'autoSync':
      case 'enabled': {
        if (typeof value !== 'boolean') {
          fail(key, `${key} 必须是布尔值`)
          break
        }
        out[key] = value
        break
      }
      default: {
        fail(key, '未知设置项')
        break
      }
    }
  }
  return { ok: errors.length === 0, patch: out, errors }
}

/**
 * 按固定键序整理一份设置值（交给 settings.mjs 自己的 writer）。
 *
 * @param values - 未知来源的对象。
 * @returns 只含 PERSISTED_KEYS 的浅拷贝（JSON 深拷贝）。
 */
export function persistedShape(values) {
  const source = isPlainObject(values) ? values : {}
  const out = {}
  for (const key of PERSISTED_KEYS) {
    if (Object.prototype.hasOwnProperty.call(source, key) && source[key] !== undefined) {
      out[key] = cloneJson(source[key])
    }
  }
  return out
}

/**
 * 保存设置文件（固定键序、2 空格缩进、尾部换行）。
 *
 * @param file - 目标文件。
 * @param values - 覆盖项集合。
 * @returns `{ok:true,file}` 或 `{ok:false,error}`。
 */
export function saveSettings(file, values) {
  const persisted = persistedShape(values)
  const text = JSON.stringify(persisted, null, 2) + '\n'
  return atomicWriteSettings(file, text)
}

/**
 * 删除设置文件（reset 用；不存在也算成功）。
 *
 * @param file - 目标文件。
 * @returns `{ok, existed, file, error?}`。
 */
export function deleteSettingsFile(file) {
  const target = pathOf(file)
  let existed = false
  try {
    existed = fs.existsSync(target)
  } catch {
    existed = false
  }
  try {
    fs.rmSync(target, { force: true })
    return { ok: true, existed, file: target }
  } catch (err) {
    return { ok: false, existed, file: target, error: `删除设置文件失败：${err && err.code ? err.code : err && err.message ? err.message : '未知错误'}` }
  }
}
