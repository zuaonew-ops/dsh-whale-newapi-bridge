/**
 * dsh-whale-newapi-bridge — 浏览器半区（设置页）。
 *
 * 在「设置」左侧导航里注册一页（slot settings.section，id whale-newapi-bridge），
 * 用来配置中转站地址、凭据名、挂件条目与同步参数，并查看最近同步 / 余额 / 警告。
 * 所有数据都由宿主半区通过 /dsh-whale-newapi/settings 提供，本文件只做读写与渲染。
 *
 * 形态说明：手写浏览器模块，走 window.__ModuleLoader__.load 的惰性工厂协议，
 * react 从浏览器模块表里 require。没有构建步骤，因此不用 JSX，全部用
 * React.createElement（别名 h）。主题色只用已核实的 --dsw-alias-* token。
 *
 * 后端契约（SPEC §6.5，与 loop-guard 的 {ok,value} 信封不同）：
 * - GET  /dsh-whale-newapi/settings -> {ok:true, config, persisted, settingsPath, sync, credential, balance, warnings}
 * - POST /dsh-whale-newapi/settings（扁平补丁）-> {ok:true, config, persisted, applied, warnings}；
 *   校验失败 400 {ok:false, code:'BAD_SETTINGS', error, fields:{key:message}}；
 *   写文件失败 500 {ok:false, code:'SAVE_FAILED', error}。
 * - POST /dsh-whale-newapi/settings/reset -> {ok:true, config, persisted:{}}。
 *
 * @module dsh-whale-newapi-bridge/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-whale-newapi-bridge',

  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** 宿主半区的两个设置端点（相对当前页面 origin，均为本机回环）。 */
    const ROUTE = {
      settings: '/dsh-whale-newapi/settings',
      reset: '/dsh-whale-newapi/settings/reset',
    }

    /** 轮询间隔（任务要求 5s）。 */
    const POLL_MS = 5000

    /** 16 个配置键，顺序与 lib/settings.mjs 的 PERSISTED_KEYS 一致。 */
    const PERSISTED_KEYS = [
      'baseUrl', 'credentialRef', 'credentialCandidates', 'authMode', 'userId',
      'modelId', 'modelName', 'currency', 'usdToCny', 'quotaPerUnit', 'fallbackTotal',
      'bridgeBaseUrl', 'autoSync', 'syncIntervalSeconds', 'requestTimeoutMs', 'enabled',
    ]

    /** 字段名 -> DICT 里的标签键（错误横幅/表单用）。 */
    const FIELD_LABEL_KEY = {
      baseUrl: 'ui.whaleNewapi.fieldBaseUrl',
      credentialRef: 'ui.whaleNewapi.fieldCredentialRef',
      credentialCandidates: 'ui.whaleNewapi.fieldCandidates',
      authMode: 'ui.whaleNewapi.fieldAuthMode',
      userId: 'ui.whaleNewapi.fieldUserId',
      modelId: 'ui.whaleNewapi.fieldModelId',
      modelName: 'ui.whaleNewapi.fieldModelName',
      currency: 'ui.whaleNewapi.fieldCurrency',
      usdToCny: 'ui.whaleNewapi.fieldUsdToCny',
      quotaPerUnit: 'ui.whaleNewapi.fieldQuotaPerUnit',
      fallbackTotal: 'ui.whaleNewapi.fieldFallbackTotal',
      bridgeBaseUrl: 'ui.whaleNewapi.fieldBridgeBaseUrl',
      autoSync: 'ui.whaleNewapi.fieldAutoSync',
      syncIntervalSeconds: 'ui.whaleNewapi.fieldSyncInterval',
      requestTimeoutMs: 'ui.whaleNewapi.fieldRequestTimeout',
      enabled: 'ui.whaleNewapi.fieldEnabled',
    }

    /** 文案。键名与仓库文档里的 ui.whaleNewapi.* 一一对应（客户端自带 DICT，不读 JSON）。 */
    const DICT = {
      zh: {
        'ui.whaleNewapi.nav': '中转站',
        'ui.whaleNewapi.title': '中转站余额',
        'ui.whaleNewapi.intro':
          '把 New API 中转站的余额接入小鲸鱼挂件。这里保存会立即热生效并写进设置文件；设置文件优先于 Loader yml 配置。',
        'ui.whaleNewapi.status': '当前状态',
        'ui.whaleNewapi.statusSource': '生效配置来源',
        'ui.whaleNewapi.statusSourceFile': '设置文件 + yml',
        'ui.whaleNewapi.statusSourceYml': 'yml / 内置默认',
        'ui.whaleNewapi.statusOverrides': '覆盖项',
        'ui.whaleNewapi.statusPath': '设置文件',
        'ui.whaleNewapi.credential': '凭据',
        'ui.whaleNewapi.credentialPresent': '已解析',
        'ui.whaleNewapi.credentialAbsent': '缺失',
        'ui.whaleNewapi.credentialRef': '凭据名',
        'ui.whaleNewapi.credentialSource': '来源',
        'ui.whaleNewapi.sync': '同步',
        'ui.whaleNewapi.syncNever': '还未同步',
        'ui.whaleNewapi.syncOk': '成功',
        'ui.whaleNewapi.syncFail': '失败',
        'ui.whaleNewapi.syncChanged': '注册表有变化',
        'ui.whaleNewapi.syncUnchanged': '注册表无变化',
        'ui.whaleNewapi.syncTrigger': '触发',
        'ui.whaleNewapi.balance': '余额',
        'ui.whaleNewapi.balanceNever': '尚未获取余额',
        'ui.whaleNewapi.balanceRemaining': '可用余额',
        'ui.whaleNewapi.balanceTotal': '总额',
        'ui.whaleNewapi.balanceUsed': '已用',
        'ui.whaleNewapi.balanceMode': '口径',
        'ui.whaleNewapi.balanceFetched': '取数时间',
        'ui.whaleNewapi.balanceUnlimited': '上游报告无限额度',
        'ui.whaleNewapi.warnings': '警告',
        'ui.whaleNewapi.noWarnings': '无警告',
        'ui.whaleNewapi.groupConnection': '连接',
        'ui.whaleNewapi.groupConnectionHint': '上游中转站地址与鉴权方式。',
        'ui.whaleNewapi.groupCredential': '凭据',
        'ui.whaleNewapi.groupCredentialHint': '凭据值本身不存在设置文件里，这里只填 DSH 凭据名。',
        'ui.whaleNewapi.groupWidget': '挂件条目',
        'ui.whaleNewapi.groupWidgetHint': '写进小鲸鱼挂件注册表的条目长什么样。',
        'ui.whaleNewapi.groupSync': '同步',
        'ui.whaleNewapi.groupSyncHint': '自动同步的开关与间隔；保存后会立刻触发一次同步。',
        'ui.whaleNewapi.groupOther': '其他',
        'ui.whaleNewapi.fieldBaseUrl': '中转站地址',
        'ui.whaleNewapi.hintBaseUrl': '例如 https://relay.example.com（http/https，不带路径、查询与用户信息）。',
        'ui.whaleNewapi.fieldAuthMode': '鉴权方式',
        'ui.whaleNewapi.hintAuthMode': 'auto 先试系统访问令牌（native），不行再退回渠道 key（compat）。',
        'ui.whaleNewapi.fieldUserId': '用户 ID',
        'ui.whaleNewapi.hintUserId': '可选。部分站点查余额需要；留空则用凭据自身。',
        'ui.whaleNewapi.fieldCredentialRef': '凭据名',
        'ui.whaleNewapi.hintCredentialRef': 'DSH 凭据名，只能字母/数字/下划线；默认 NEWAPI_RELAY_TOKEN。',
        'ui.whaleNewapi.fieldCandidates': '候选凭据（逗号或换行分隔）',
        'ui.whaleNewapi.hintCandidates': '按顺序回退：第一个能解析的胜出。',
        'ui.whaleNewapi.fieldModelId': '条目 id',
        'ui.whaleNewapi.hintModelId': '写进 .dshw-api.json 的模型 id，只能字母/数字/下划线/短横线。',
        'ui.whaleNewapi.fieldModelName': '显示名',
        'ui.whaleNewapi.hintModelName': '挂件里看到的名字，最多 100 个字符。',
        'ui.whaleNewapi.fieldCurrency': '币种',
        'ui.whaleNewapi.hintCurrency': '余额展示币种；CNY 时按 USD 到 CNY 的汇率换算。',
        'ui.whaleNewapi.fieldUsdToCny': 'USD 到 CNY 汇率',
        'ui.whaleNewapi.hintUsdToCny': '0 表示用站点默认；CNY 口径时生效。',
        'ui.whaleNewapi.fieldQuotaPerUnit': '每 unit 的 quota',
        'ui.whaleNewapi.hintQuotaPerUnit': '0 表示用站点默认；native 口径换算用。',
        'ui.whaleNewapi.fieldFallbackTotal': '人工总额度',
        'ui.whaleNewapi.hintFallbackTotal': '上游是无限额度时，用这个数当总额度估算可用余额；0 表示不估算。',
        'ui.whaleNewapi.fieldAutoSync': '自动同步',
        'ui.whaleNewapi.hintAutoSync': '打开后按下面的间隔定时刷新注册表与余额。',
        'ui.whaleNewapi.fieldSyncInterval': '同步间隔',
        'ui.whaleNewapi.hintSyncInterval': '整数秒，5 到 86400。',
        'ui.whaleNewapi.unitSeconds': '秒',
        'ui.whaleNewapi.fieldRequestTimeout': '请求超时',
        'ui.whaleNewapi.hintRequestTimeout': '整数毫秒，1000 到 120000。',
        'ui.whaleNewapi.unitMs': '毫秒',
        'ui.whaleNewapi.fieldBridgeBaseUrl': '桥地址覆盖',
        'ui.whaleNewapi.hintBridgeBaseUrl': '留空自动探测；只允许本机回环 origin（如 http://127.0.0.1:3000）。',
        'ui.whaleNewapi.fieldEnabled': '启用插件',
        'ui.whaleNewapi.hintEnabled': '关掉后不写注册表（会移除本插件的条目），本机路由仍在。',
        'ui.whaleNewapi.save': '保存',
        'ui.whaleNewapi.saving': '保存中…',
        'ui.whaleNewapi.saved': '已保存并热生效',
        'ui.whaleNewapi.noChanges': '没有需要保存的改动',
        'ui.whaleNewapi.reset': '恢复默认',
        'ui.whaleNewapi.resetting': '恢复中…',
        'ui.whaleNewapi.resetDone': '已恢复默认（设置文件已删除）',
        'ui.whaleNewapi.resetConfirm': '删除设置文件并恢复 yml / 内置默认值？',
        'ui.whaleNewapi.refresh': '刷新',
        'ui.whaleNewapi.refreshing': '刷新中…',
        'ui.whaleNewapi.loading': '加载中…',
        'ui.whaleNewapi.error': '操作失败',
        'ui.whaleNewapi.retry': '重试',
        'ui.whaleNewapi.netFail': '网络请求失败',
        'ui.whaleNewapi.badJson': '响应不是合法 JSON，',
        'ui.whaleNewapi.hintFilePriority': '设置文件优先于 yml：这里保存的值会覆盖 Loader 配置。',
        'ui.whaleNewapi.authAuto': '自动（先 native 后 compat）',
        'ui.whaleNewapi.authNative': '系统访问令牌（native）',
        'ui.whaleNewapi.authCompat': '渠道 key（compat）',
        'ui.whaleNewapi.modeBalance': '数值余额',
        'ui.whaleNewapi.modeEvents': '事件估算（events）',
        'ui.whaleNewapi.unknown': '—',
      },
      en: {
        'ui.whaleNewapi.nav': 'Relay',
        'ui.whaleNewapi.title': 'Relay balance',
        'ui.whaleNewapi.intro':
          'Connect the New API relay balance to the whale widget. Saving here takes effect immediately and writes the settings file; the settings file overrides Loader yml config.',
        'ui.whaleNewapi.status': 'Status',
        'ui.whaleNewapi.statusSource': 'Effective config source',
        'ui.whaleNewapi.statusSourceFile': 'settings file + yml',
        'ui.whaleNewapi.statusSourceYml': 'yml / built-in defaults',
        'ui.whaleNewapi.statusOverrides': 'Overrides',
        'ui.whaleNewapi.statusPath': 'Settings file',
        'ui.whaleNewapi.credential': 'Credential',
        'ui.whaleNewapi.credentialPresent': 'resolved',
        'ui.whaleNewapi.credentialAbsent': 'missing',
        'ui.whaleNewapi.credentialRef': 'Credential name',
        'ui.whaleNewapi.credentialSource': 'Source',
        'ui.whaleNewapi.sync': 'Sync',
        'ui.whaleNewapi.syncNever': 'Not synced yet',
        'ui.whaleNewapi.syncOk': 'ok',
        'ui.whaleNewapi.syncFail': 'failed',
        'ui.whaleNewapi.syncChanged': 'registry changed',
        'ui.whaleNewapi.syncUnchanged': 'registry unchanged',
        'ui.whaleNewapi.syncTrigger': 'trigger',
        'ui.whaleNewapi.balance': 'Balance',
        'ui.whaleNewapi.balanceNever': 'No balance fetched yet',
        'ui.whaleNewapi.balanceRemaining': 'Remaining',
        'ui.whaleNewapi.balanceTotal': 'Total',
        'ui.whaleNewapi.balanceUsed': 'Used',
        'ui.whaleNewapi.balanceMode': 'Mode',
        'ui.whaleNewapi.balanceFetched': 'Fetched at',
        'ui.whaleNewapi.balanceUnlimited': 'Upstream reports unlimited quota',
        'ui.whaleNewapi.warnings': 'Warnings',
        'ui.whaleNewapi.noWarnings': 'No warnings',
        'ui.whaleNewapi.groupConnection': 'Connection',
        'ui.whaleNewapi.groupConnectionHint': 'Upstream relay address and auth mode.',
        'ui.whaleNewapi.groupCredential': 'Credential',
        'ui.whaleNewapi.groupCredentialHint': 'The credential value is never stored in the settings file; only its DSH credential name.',
        'ui.whaleNewapi.groupWidget': 'Widget entry',
        'ui.whaleNewapi.groupWidgetHint': 'How the entry in the whale widget registry looks.',
        'ui.whaleNewapi.groupSync': 'Sync',
        'ui.whaleNewapi.groupSyncHint': 'Auto-sync switch and interval; saving triggers one sync immediately.',
        'ui.whaleNewapi.groupOther': 'Other',
        'ui.whaleNewapi.fieldBaseUrl': 'Relay base URL',
        'ui.whaleNewapi.hintBaseUrl': 'For example https://relay.example.com (http/https, no path, query or userinfo).',
        'ui.whaleNewapi.fieldAuthMode': 'Auth mode',
        'ui.whaleNewapi.hintAuthMode': 'auto tries the system access token (native) first, then falls back to a channel key (compat).',
        'ui.whaleNewapi.fieldUserId': 'User ID',
        'ui.whaleNewapi.hintUserId': 'Optional. Some sites need it to look up the balance; blank means use the credential itself.',
        'ui.whaleNewapi.fieldCredentialRef': 'Credential name',
        'ui.whaleNewapi.hintCredentialRef': 'DSH credential name: letters/digits/underscore only; defaults to NEWAPI_RELAY_TOKEN.',
        'ui.whaleNewapi.fieldCandidates': 'Candidate credentials (comma or newline separated)',
        'ui.whaleNewapi.hintCandidates': 'Tried in order; the first one that resolves wins.',
        'ui.whaleNewapi.fieldModelId': 'Entry id',
        'ui.whaleNewapi.hintModelId': 'Model id written into .dshw-api.json: letters/digits/underscore/hyphen only.',
        'ui.whaleNewapi.fieldModelName': 'Display name',
        'ui.whaleNewapi.hintModelName': 'Name shown in the widget; at most 100 characters.',
        'ui.whaleNewapi.fieldCurrency': 'Currency',
        'ui.whaleNewapi.hintCurrency': 'Display currency; CNY converts via the USD to CNY rate.',
        'ui.whaleNewapi.fieldUsdToCny': 'USD to CNY rate',
        'ui.whaleNewapi.hintUsdToCny': '0 means use the site default; applies in CNY mode.',
        'ui.whaleNewapi.fieldQuotaPerUnit': 'Quota per unit',
        'ui.whaleNewapi.hintQuotaPerUnit': '0 means use the site default; used by native conversion.',
        'ui.whaleNewapi.fieldFallbackTotal': 'Manual total quota',
        'ui.whaleNewapi.hintFallbackTotal': 'When upstream is unlimited, use this as the total to estimate remaining; 0 disables estimation.',
        'ui.whaleNewapi.fieldAutoSync': 'Auto sync',
        'ui.whaleNewapi.hintAutoSync': 'Refresh the registry and balance on the interval below.',
        'ui.whaleNewapi.fieldSyncInterval': 'Sync interval',
        'ui.whaleNewapi.hintSyncInterval': 'Integer seconds, 5 to 86400.',
        'ui.whaleNewapi.unitSeconds': 's',
        'ui.whaleNewapi.fieldRequestTimeout': 'Request timeout',
        'ui.whaleNewapi.hintRequestTimeout': 'Integer milliseconds, 1000 to 120000.',
        'ui.whaleNewapi.unitMs': 'ms',
        'ui.whaleNewapi.fieldBridgeBaseUrl': 'Bridge base URL override',
        'ui.whaleNewapi.hintBridgeBaseUrl': 'Blank means auto-detect; only loopback origins are allowed (e.g. http://127.0.0.1:3000).',
        'ui.whaleNewapi.fieldEnabled': 'Plugin enabled',
        'ui.whaleNewapi.hintEnabled': 'When off, the registry is not written (our entry is removed); loopback routes stay up.',
        'ui.whaleNewapi.save': 'Save',
        'ui.whaleNewapi.saving': 'Saving...',
        'ui.whaleNewapi.saved': 'Saved and applied live',
        'ui.whaleNewapi.noChanges': 'Nothing to save',
        'ui.whaleNewapi.reset': 'Restore defaults',
        'ui.whaleNewapi.resetting': 'Restoring...',
        'ui.whaleNewapi.resetDone': 'Restored defaults (settings file deleted)',
        'ui.whaleNewapi.resetConfirm': 'Delete the settings file and fall back to yml / built-in defaults?',
        'ui.whaleNewapi.refresh': 'Refresh',
        'ui.whaleNewapi.refreshing': 'Refreshing...',
        'ui.whaleNewapi.loading': 'Loading...',
        'ui.whaleNewapi.error': 'Action failed',
        'ui.whaleNewapi.retry': 'Retry',
        'ui.whaleNewapi.netFail': 'Network request failed',
        'ui.whaleNewapi.badJson': 'Response was not valid JSON, ',
        'ui.whaleNewapi.hintFilePriority': 'The settings file overrides yml: values saved here win over Loader config.',
        'ui.whaleNewapi.authAuto': 'Auto (native, then compat)',
        'ui.whaleNewapi.authNative': 'System access token (native)',
        'ui.whaleNewapi.authCompat': 'Channel key (compat)',
        'ui.whaleNewapi.modeBalance': 'Numeric balance',
        'ui.whaleNewapi.modeEvents': 'Event estimate (events)',
        'ui.whaleNewapi.unknown': '—',
      },
    }

    const LANG = (
      (typeof navigator !== 'undefined' && navigator.language) ||
      'zh'
    ).toLowerCase().startsWith('zh')
      ? 'zh'
      : 'en'

    /** 取一条文案（DICT 里没有的退回中文）。 */
    function t(key, ...args) {
      const value = DICT[LANG][key] ?? DICT.zh[key]
      return typeof value === 'function' ? value(...args) : value
    }

    /** 已核实的主题 token，不发明新名字。 */
    const TOKEN = {
      text: 'var(--dsw-alias-label-primary)',
      dim: 'var(--dsw-alias-label-secondary)',
      border: 'var(--dsw-alias-border-l1)',
      borderStrong: 'var(--dsw-alias-border-l2)',
      surface: 'var(--dsw-alias-bg-layer-1)',
      nested: 'var(--dsw-alias-bg-layer-2)',
      brand: 'var(--dsw-alias-brand-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
      success: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
    }

    const INPUT_STYLE = {
      width: '100%',
      boxSizing: 'border-box',
      font: 'inherit',
      fontSize: 13,
      padding: '5px 8px',
      marginTop: 4,
      color: TOKEN.text,
      background: TOKEN.nested,
      border: '1px solid ' + TOKEN.border,
      borderRadius: 6,
    }

    const CARD_STYLE = {
      background: TOKEN.surface,
      border: '1px solid ' + TOKEN.border,
      borderRadius: 8,
      padding: '12px 14px',
      marginBottom: 12,
    }

    const HINT_STYLE = { margin: '2px 0 0', fontSize: 11, lineHeight: 1.5, color: TOKEN.dim }
    const LABEL_STYLE = { fontSize: 13, fontWeight: 600, color: TOKEN.text }
    const ERROR_STYLE = { ...HINT_STYLE, color: TOKEN.error }

    /** POST 的 fetch 选项。 */
    function post(body) {
      return {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }
    }

    /** 任意值 -> 可读错误文本。 */
    function errText(error) {
      return String((error && error.message) || error)
    }

    /**
     * 统一请求。本插件的宿主响应不是 {ok,value} 信封，而是直接返回
     * {ok:true, ...} / {ok:false, code, error, fields}（见 SPEC §6.5）。
     * 失败时抛 Error，并把 code / fields / status 挂到错误对象上供表单展示。
     */
    async function request(path, options) {
      let response
      try {
        response = await fetch(path, options)
      } catch (error) {
        throw new Error(t('ui.whaleNewapi.netFail') + ': ' + errText(error))
      }
      let payload
      try {
        payload = await response.json()
      } catch (error) {
        throw new Error(t('ui.whaleNewapi.badJson') + 'HTTP ' + response.status)
      }
      if (!payload || payload.ok !== true) {
        const detail = payload && (payload.error || payload.code)
        const failure = new Error(detail ? String(detail) : 'HTTP ' + response.status)
        failure.code = payload && payload.code
        failure.fields = payload && payload.fields ? payload.fields : null
        failure.status = response.status
        throw failure
      }
      return payload
    }

    /** epoch 毫秒 / ISO 字符串 -> 本地时间文本；非法值原样返回。 */
    function formatAt(value) {
      if (value === null || value === undefined || value === '') return t('ui.whaleNewapi.unknown')
      const date = new Date(typeof value === 'number' ? value : String(value))
      if (Number.isNaN(date.getTime())) return String(value)
      try {
        return date.toLocaleString()
      } catch (error) {
        return date.toISOString()
      }
    }

    /** 数字金额 -> 两位小数 + 币种；null/非法值显示占位。 */
    function formatMoney(value, currency) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return t('ui.whaleNewapi.unknown')
      const text = value.toFixed(2)
      return typeof currency === 'string' && currency !== '' ? text + ' ' + currency : text
    }

    /** 16 个配置值 -> 受控表单的字符串/布尔形态（凭据候选写成多行文本）。 */
    function formFromConfig(config) {
      const cfg = config !== null && typeof config === 'object' ? config : {}
      const candidates = Array.isArray(cfg.credentialCandidates) ? cfg.credentialCandidates : []
      return {
        baseUrl: String(cfg.baseUrl ?? ''),
        credentialRef: String(cfg.credentialRef ?? ''),
        credentialCandidates: candidates.join('\n'),
        authMode: String(cfg.authMode ?? 'auto'),
        userId: String(cfg.userId ?? ''),
        modelId: String(cfg.modelId ?? ''),
        modelName: String(cfg.modelName ?? ''),
        currency: String(cfg.currency ?? 'CNY'),
        usdToCny: String(cfg.usdToCny ?? ''),
        quotaPerUnit: String(cfg.quotaPerUnit ?? ''),
        fallbackTotal: String(cfg.fallbackTotal ?? ''),
        bridgeBaseUrl: String(cfg.bridgeBaseUrl ?? ''),
        autoSync: cfg.autoSync === true,
        syncIntervalSeconds: String(cfg.syncIntervalSeconds ?? ''),
        requestTimeoutMs: String(cfg.requestTimeoutMs ?? ''),
        enabled: cfg.enabled === true,
      }
    }

    /** 表单值 -> 提交给宿主的带类型值（数字串转数字，空串转 NaN 交给宿主报错）。 */
    function typedValue(key, form) {
      switch (key) {
        case 'baseUrl':
        case 'credentialRef':
        case 'authMode':
        case 'userId':
        case 'modelId':
        case 'modelName':
        case 'currency':
        case 'bridgeBaseUrl':
          return String(form[key] ?? '').trim()
        case 'credentialCandidates':
          return String(form[key] ?? '')
            .split(/[\s,，]+/)
            .filter((item) => item !== '')
        case 'usdToCny':
        case 'quotaPerUnit':
        case 'fallbackTotal':
        case 'syncIntervalSeconds':
        case 'requestTimeoutMs':
          return Number(String(form[key] ?? '').trim())
        case 'autoSync':
        case 'enabled':
          return form[key] === true
        default:
          return form[key]
      }
    }

    /** 只有与当前生效配置不同的键才提交（任务要求「只提交有变化的键」）。 */
    function changedPatch(form, config) {
      const cfg = config !== null && typeof config === 'object' ? config : {}
      const patch = {}
      for (const key of PERSISTED_KEYS) {
        const next = typedValue(key, form)
        const before = cfg[key]
        if (JSON.stringify(next) !== JSON.stringify(before)) patch[key] = next
      }
      return patch
    }

    // ---- 展示组件 ----------------------------------------------------------

    /** 一个文字按钮。 */
    function Button(props) {
      return h('button', {
        type: 'button',
        title: props.title,
        disabled: props.disabled,
        onClick: props.onClick,
        style: {
          flex: '0 0 auto',
          padding: '5px 12px',
          fontSize: 12,
          font: 'inherit',
          cursor: props.disabled ? 'default' : 'pointer',
          opacity: props.disabled ? 0.45 : 1,
          color: props.primary ? '#fff' : props.danger ? TOKEN.error : TOKEN.text,
          background: props.primary ? TOKEN.brand : 'transparent',
          border: '1px solid ' + (props.primary ? TOKEN.brand : TOKEN.border),
          borderRadius: 6,
        },
      }, props.children)
    }

    /** 卡片：标题 + 提示 + 内容。 */
    function Card(props) {
      return h('section', { style: CARD_STYLE },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: props.children ? 8 : 0 } },
          h('span', { style: { ...LABEL_STYLE, fontSize: 14 } }, props.title),
          h('span', { style: { flex: '1 1 auto' } }),
        ),
        props.hint === undefined ? null : h('p', { style: HINT_STYLE }, props.hint),
        props.children,
      )
    }

    /** 表单行：标题 + 控件 + 说明 + 字段级错误。 */
    function Field(props) {
      return h('div', { style: { margin: '0 0 12px' } },
        h('div', { style: LABEL_STYLE }, props.label),
        props.children,
        props.hint === undefined ? null : h('p', { style: HINT_STYLE }, props.hint),
        props.error === undefined ? null : h('p', { style: ERROR_STYLE }, props.error),
      )
    }

    /** 开关：checkbox + 文字。 */
    function Toggle(props) {
      return h('label', {
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          margin: '4px 0 0',
          cursor: props.disabled ? 'default' : 'pointer',
          opacity: props.disabled ? 0.6 : 1,
        },
      },
        h('input', {
          type: 'checkbox',
          checked: props.checked === true,
          disabled: props.disabled,
          onChange: () => props.onChange(props.checked !== true),
        }),
        h('span', { style: { fontSize: 13, color: TOKEN.text } }, props.label),
      )
    }

    /** 状态里的一行「标签：值」。 */
    function InfoRow(props) {
      return h('div', { style: { display: 'flex', gap: 8, margin: '2px 0', fontSize: 12, lineHeight: 1.7 } },
        h('span', { style: { flex: '0 0 auto', minWidth: 96, color: TOKEN.dim } }, props.label),
        h('span', { style: { color: props.color || TOKEN.text, wordBreak: 'break-all' } }, props.value),
      )
    }

    /** 一个统计格（余额区用）。 */
    function Stat(props) {
      return h('div', {
        style: {
          flex: '1 1 0',
          minWidth: 108,
          padding: '8px 10px',
          background: TOKEN.nested,
          border: '1px solid ' + TOKEN.border,
          borderRadius: 6,
        },
      },
        h('div', { style: { fontSize: 11, color: TOKEN.dim } }, props.label),
        h('div', { style: { fontSize: 15, fontWeight: 600, color: props.color || TOKEN.text, marginTop: 2 } }, props.value),
      )
    }

    // ---- 设置页主体 --------------------------------------------------------

    /** 设置页主体：读当前配置与状态，编辑 16 项，保存/恢复默认/刷新。 */
    function BridgeSettingsSection(props) {
      const [data, setData] = React.useState(null)
      const [status, setStatus] = React.useState('loading')
      const [form, setForm] = React.useState(() => formFromConfig({}))
      const [message, setMessage] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [fieldErrors, setFieldErrors] = React.useState({})

      const alive = React.useRef(true)
      const timer = React.useRef(null)
      const inflight = React.useRef(null)
      const dirty = React.useRef(false)
      const hasData = React.useRef(false)

      /** 用宿主返回的配置回填表单（用户改过就不动，避免轮询冲掉输入）。 */
      const fillForm = React.useCallback((config) => {
        if (dirty.current) return
        setForm(formFromConfig(config))
      }, [])

      /** 停掉轮询定时器。 */
      const stopPolling = React.useCallback(() => {
        if (timer.current !== null) {
          clearTimeout(timer.current)
          timer.current = null
        }
      }, [])

      /** 拉一次 /settings。silent = 轮询触发（不闪 loading、不清成功提示）。 */
      const load = React.useCallback((silent) => {
        if (!silent) {
          setStatus('loading')
          setMessage('')
        }
        if (inflight.current) {
          try { inflight.current.abort() } catch (error) { /* abort 失败无所谓 */ }
        }
        let controller = null
        if (typeof AbortController === 'function') controller = new AbortController()
        inflight.current = controller
        return request(ROUTE.settings, controller ? { signal: controller.signal } : undefined)
          .then((payload) => {
            if (!alive.current) return
            hasData.current = true
            setData(payload)
            setStatus('ready')
            setMessage('')
            fillForm(payload.config)
          })
          .catch((error) => {
            if (!alive.current) return
            if (silent && hasData.current) {
              // 轮询失败不清已有内容：只在状态区提示，保留旧数据。
              setMessage(errText(error))
              return
            }
            setStatus('error')
            setMessage(errText(error))
          })
      }, [fillForm])

      /** 排下一次轮询（永远只有一根定时器）。 */
      const schedule = React.useCallback(() => {
        stopPolling()
        timer.current = setTimeout(() => {
          timer.current = null
          load(true).then(() => {
            if (alive.current) schedule()
          })
        }, POLL_MS)
      }, [load, stopPolling])

      React.useEffect(() => {
        alive.current = true
        dirty.current = false
        hasData.current = false
        load(false).then(() => {
          if (alive.current) schedule()
        })
        return () => {
          alive.current = false
          stopPolling()
          if (inflight.current) {
            try { inflight.current.abort() } catch (error) { /* 卸载时 abort 失败无需处理 */ }
          }
        }
      }, [load, schedule, stopPolling])

      /** 改一个表单值。 */
      const change = React.useCallback((key, value) => {
        dirty.current = true
        setFieldErrors((prev) => {
          if (!prev || prev[key] === undefined) return prev
          const next = { ...prev }
          delete next[key]
          return next
        })
        setForm((prev) => ({ ...prev, [key]: value }))
      }, [])

      /** 用一次成功响应刷新本地状态（config/persisted/warnings + 表单）。 */
      const applyResponse = React.useCallback((payload) => {
        setData((prev) => {
          const base = prev !== null && typeof prev === 'object' ? prev : {}
          return {
            ...base,
            config: payload.config || base.config,
            persisted: payload.persisted !== undefined ? payload.persisted : base.persisted,
            warnings: Array.isArray(payload.warnings) ? payload.warnings : base.warnings,
          }
        })
        dirty.current = false
        setFieldErrors({})
        if (payload.config) setForm(formFromConfig(payload.config))
      }, [])

      /** 保存：只提交有变化的键；400 的字段级错误逐项展示。 */
      const save = React.useCallback(() => {
        const config = data && typeof data.config === 'object' ? data.config : {}
        const patch = changedPatch(form, config)
        setMessage('')
        setNotice('')
        if (Object.keys(patch).length === 0) {
          setNotice(t('ui.whaleNewapi.noChanges'))
          return Promise.resolve()
        }
        setBusy('save')
        return request(ROUTE.settings, post(patch))
          .then((payload) => {
            if (!alive.current) return
            applyResponse(payload)
            setStatus('ready')
            setNotice(t('ui.whaleNewapi.saved'))
          })
          .catch((error) => {
            if (!alive.current) return
            if (error && error.fields && typeof error.fields === 'object') {
              const next = {}
              for (const key of Object.keys(error.fields)) {
                if (key === '*') {
                  setMessage(String(error.fields[key]))
                  continue
                }
                next[key] = String(error.fields[key])
              }
              setFieldErrors(next)
            }
            setStatus('error')
            setMessage(errText(error))
          })
          .then(() => {
            if (alive.current) setBusy('')
          })
      }, [applyResponse, data, form])

      /** 恢复默认：删除设置文件并回退 yml / 内置默认。 */
      const reset = React.useCallback(() => {
        if (typeof window !== 'undefined' && typeof window.confirm === 'function' &&
          !window.confirm(t('ui.whaleNewapi.resetConfirm'))) {
          return Promise.resolve()
        }
        setBusy('reset')
        setMessage('')
        setNotice('')
        return request(ROUTE.reset, post({}))
          .then((payload) => {
            if (!alive.current) return
            applyResponse(payload)
            setStatus('ready')
            setNotice(t('ui.whaleNewapi.resetDone'))
          })
          .catch((error) => {
            if (!alive.current) return
            setStatus('error')
            setMessage(errText(error))
          })
          .then(() => {
            if (alive.current) setBusy('')
          })
      }, [applyResponse])

      /** 手动刷新。 */
      const refresh = React.useCallback(() => {
        setBusy('refresh')
        setNotice('')
        return load(false).then(() => {
          if (alive.current) setBusy('')
        })
      }, [load])

      const config = data && typeof data.config === 'object' && data.config !== null ? data.config : {}
      const persisted = data && typeof data.persisted === 'object' && data.persisted !== null ? data.persisted : {}
      const sync = data && typeof data.sync === 'object' && data.sync !== null ? data.sync : {}
      const credential = data && typeof data.credential === 'object' && data.credential !== null ? data.credential : {}
      const balance = data && typeof data.balance === 'object' && data.balance !== null ? data.balance : null
      const warnings = data && Array.isArray(data.warnings) ? data.warnings : []
      const locked = busy !== ''

      /** 字段级错误的展示文本。 */
      const fieldError = (key) => (fieldErrors[key] === undefined ? undefined : fieldErrors[key])

      /** 一个文本输入行。 */
      const textField = (key, labelKey, hintKey) => Field({
        label: t(labelKey),
        hint: t(hintKey),
        error: fieldError(key),
        children: h('input', {
          type: 'text',
          value: form[key],
          disabled: locked,
          spellCheck: false,
          onChange: (event) => change(key, event.target.value),
          style: INPUT_STYLE,
        }),
      })

      /** 一个数字输入行（text + inputMode，空串交给宿主校验）。 */
      const numberField = (key, labelKey, hintKey, unitKey) => Field({
        label: t(labelKey),
        hint: t(hintKey),
        error: fieldError(key),
        children: h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
          h('input', {
            type: 'text',
            inputMode: 'decimal',
            value: form[key],
            disabled: locked,
            onChange: (event) => change(key, event.target.value),
            style: { ...INPUT_STYLE, maxWidth: 180 },
          }),
          unitKey === undefined ? null : h('span', { style: { fontSize: 12, color: TOKEN.dim, marginTop: 4 } }, t(unitKey)),
        ),
      })

      // ---- 状态区 --------------------------------------------------------
      const persistedKeys = Object.keys(persisted)
      const balanceStats = []
      if (balance !== null && balance.ok === true) {
        balanceStats.push(Stat({ key: 'remaining', label: t('ui.whaleNewapi.balanceRemaining'), value: formatMoney(balance.remaining, balance.currency) }))
        balanceStats.push(Stat({ key: 'total', label: t('ui.whaleNewapi.balanceTotal'), value: formatMoney(balance.total, balance.currency) }))
        balanceStats.push(Stat({ key: 'used', label: t('ui.whaleNewapi.balanceUsed'), value: formatMoney(balance.used, balance.currency) }))
      }
      const balanceLines = []
      if (balance === null) {
        balanceLines.push(h('p', { key: 'never', style: HINT_STYLE }, t('ui.whaleNewapi.balanceNever')))
      } else if (balance.ok === true) {
        if (balanceStats.length > 0) {
          balanceLines.push(h('div', {
            key: 'stats',
            style: { display: 'flex', gap: 8, flexWrap: 'wrap', margin: '6px 0' },
          }, ...balanceStats))
        }
        balanceLines.push(InfoRow({
          key: 'meta',
          label: t('ui.whaleNewapi.balanceFetched'),
          value: formatAt(balance.fetchedAt) + ' · ' + (balance.mode === 'events' ? t('ui.whaleNewapi.modeEvents') : t('ui.whaleNewapi.modeBalance')),
        }))
        if (balance.unlimited === true) {
          balanceLines.push(h('p', { key: 'unlimited', style: HINT_STYLE }, t('ui.whaleNewapi.balanceUnlimited')))
        }
      } else {
        balanceLines.push(InfoRow({
          key: 'error',
          label: t('ui.whaleNewapi.balance'),
          value: (String(balance.code || '') + ' ' + String(balance.error || '')).trim(),
          color: TOKEN.error,
        }))
      }

      const syncText = (() => {
        if (sync.lastSyncAt === null || sync.lastSyncAt === undefined) return t('ui.whaleNewapi.syncNever')
        const result = sync.lastSyncResult !== null && typeof sync.lastSyncResult === 'object' ? sync.lastSyncResult : {}
        const parts = []
        parts.push(result.ok === true ? t('ui.whaleNewapi.syncOk') : t('ui.whaleNewapi.syncFail'))
        parts.push(result.changed === true ? t('ui.whaleNewapi.syncChanged') : t('ui.whaleNewapi.syncUnchanged'))
        if (typeof result.mode === 'string' && result.mode !== '') parts.push(result.mode)
        if (typeof sync.lastSyncTrigger === 'string' && sync.lastSyncTrigger !== '') {
          parts.push(t('ui.whaleNewapi.syncTrigger') + ' ' + sync.lastSyncTrigger)
        }
        return formatAt(sync.lastSyncAt) + ' · ' + parts.join(' · ')
      })()

      const statusCard = Card({
        key: 'status',
        title: t('ui.whaleNewapi.status'),
        children: h('div', null,
          InfoRow({
            label: t('ui.whaleNewapi.statusSource'),
            value: persistedKeys.length > 0
              ? t('ui.whaleNewapi.statusSourceFile') + '（' + t('ui.whaleNewapi.statusOverrides') + '：' + persistedKeys.join(', ') + '）'
              : t('ui.whaleNewapi.statusSourceYml'),
          }),
          InfoRow({
            label: t('ui.whaleNewapi.credential'),
            value: t('ui.whaleNewapi.credentialRef') + ' ' + (credential.ref || t('ui.whaleNewapi.unknown'))
              + ' · ' + (credential.present === true ? t('ui.whaleNewapi.credentialPresent') : t('ui.whaleNewapi.credentialAbsent'))
              + ' · ' + t('ui.whaleNewapi.credentialSource') + ' ' + (credential.source || t('ui.whaleNewapi.unknown')),
          }),
          InfoRow({ label: t('ui.whaleNewapi.sync'), value: syncText }),
          InfoRow({ label: t('ui.whaleNewapi.statusPath'), value: data && data.settingsPath ? data.settingsPath : t('ui.whaleNewapi.unknown'), color: TOKEN.dim }),
          h('div', { style: { marginTop: 8 } },
            h('div', { style: { ...LABEL_STYLE, fontSize: 12, color: TOKEN.dim, marginBottom: 2 } }, t('ui.whaleNewapi.balance')),
            ...balanceLines,
          ),
          h('div', { style: { marginTop: 8 } },
            h('div', { style: { ...LABEL_STYLE, fontSize: 12, color: TOKEN.dim, marginBottom: 2 } },
              t('ui.whaleNewapi.warnings') + '（' + warnings.length + '）'),
            warnings.length === 0
              ? h('p', { style: HINT_STYLE }, t('ui.whaleNewapi.noWarnings'))
              : h('ul', { style: { margin: '2px 0 0', paddingLeft: 18, fontSize: 12, lineHeight: 1.6, color: TOKEN.warn } },
                ...warnings.map((warning, index) => h('li', { key: index }, String(warning)))),
          ),
        ),
      })

      // ---- 表单卡片 ------------------------------------------------------
      const connectionCard = Card({
        key: 'connection',
        title: t('ui.whaleNewapi.groupConnection'),
        hint: t('ui.whaleNewapi.groupConnectionHint'),
        children: h('div', null,
          textField('baseUrl', 'ui.whaleNewapi.fieldBaseUrl', 'ui.whaleNewapi.hintBaseUrl'),
          Field({
            label: t('ui.whaleNewapi.fieldAuthMode'),
            hint: t('ui.whaleNewapi.hintAuthMode'),
            error: fieldError('authMode'),
            children: h('select', {
              value: form.authMode,
              disabled: locked,
              onChange: (event) => change('authMode', event.target.value),
              style: INPUT_STYLE,
            },
              h('option', { value: 'auto' }, t('ui.whaleNewapi.authAuto')),
              h('option', { value: 'native' }, t('ui.whaleNewapi.authNative')),
              h('option', { value: 'compat' }, t('ui.whaleNewapi.authCompat')),
            ),
          }),
          textField('userId', 'ui.whaleNewapi.fieldUserId', 'ui.whaleNewapi.hintUserId'),
        ),
      })

      const credentialCard = Card({
        key: 'credential',
        title: t('ui.whaleNewapi.groupCredential'),
        hint: t('ui.whaleNewapi.groupCredentialHint'),
        children: h('div', null,
          textField('credentialRef', 'ui.whaleNewapi.fieldCredentialRef', 'ui.whaleNewapi.hintCredentialRef'),
          Field({
            label: t('ui.whaleNewapi.fieldCandidates'),
            hint: t('ui.whaleNewapi.hintCandidates'),
            error: fieldError('credentialCandidates'),
            children: h('textarea', {
              rows: 4,
              value: form.credentialCandidates,
              disabled: locked,
              spellCheck: false,
              onChange: (event) => change('credentialCandidates', event.target.value),
              style: { ...INPUT_STYLE, resize: 'vertical' },
            }),
          }),
        ),
      })

      const currencyField = Field({
        label: t('ui.whaleNewapi.fieldCurrency'),
        hint: t('ui.whaleNewapi.hintCurrency'),
        error: fieldError('currency'),
        children: h('select', {
          value: form.currency,
          disabled: locked,
          onChange: (event) => change('currency', event.target.value),
          style: INPUT_STYLE,
        },
          h('option', { value: 'CNY' }, 'CNY'),
          h('option', { value: 'USD' }, 'USD'),
        ),
      })

      const widgetCard = Card({
        key: 'widget',
        title: t('ui.whaleNewapi.groupWidget'),
        hint: t('ui.whaleNewapi.groupWidgetHint'),
        children: h('div', null,
          textField('modelId', 'ui.whaleNewapi.fieldModelId', 'ui.whaleNewapi.hintModelId'),
          textField('modelName', 'ui.whaleNewapi.fieldModelName', 'ui.whaleNewapi.hintModelName'),
          currencyField,
          numberField('usdToCny', 'ui.whaleNewapi.fieldUsdToCny', 'ui.whaleNewapi.hintUsdToCny'),
          numberField('quotaPerUnit', 'ui.whaleNewapi.fieldQuotaPerUnit', 'ui.whaleNewapi.hintQuotaPerUnit'),
          numberField('fallbackTotal', 'ui.whaleNewapi.fieldFallbackTotal', 'ui.whaleNewapi.hintFallbackTotal'),
        ),
      })

      const syncCard = Card({
        key: 'sync',
        title: t('ui.whaleNewapi.groupSync'),
        hint: t('ui.whaleNewapi.groupSyncHint'),
        children: h('div', null,
          Field({
            label: t('ui.whaleNewapi.fieldAutoSync'),
            hint: t('ui.whaleNewapi.hintAutoSync'),
            error: fieldError('autoSync'),
            children: Toggle({
              checked: form.autoSync,
              disabled: locked,
              label: t('ui.whaleNewapi.fieldAutoSync'),
              onChange: (next) => change('autoSync', next),
            }),
          }),
          numberField('syncIntervalSeconds', 'ui.whaleNewapi.fieldSyncInterval', 'ui.whaleNewapi.hintSyncInterval', 'ui.whaleNewapi.unitSeconds'),
          numberField('requestTimeoutMs', 'ui.whaleNewapi.fieldRequestTimeout', 'ui.whaleNewapi.hintRequestTimeout', 'ui.whaleNewapi.unitMs'),
          textField('bridgeBaseUrl', 'ui.whaleNewapi.fieldBridgeBaseUrl', 'ui.whaleNewapi.hintBridgeBaseUrl'),
        ),
      })

      const otherCard = Card({
        key: 'other',
        title: t('ui.whaleNewapi.groupOther'),
        children: Field({
          label: t('ui.whaleNewapi.fieldEnabled'),
          hint: t('ui.whaleNewapi.hintEnabled'),
          error: fieldError('enabled'),
          children: Toggle({
            checked: form.enabled,
            disabled: locked,
            label: t('ui.whaleNewapi.fieldEnabled'),
            onChange: (next) => change('enabled', next),
          }),
        }),
      })

      const saveBar = h('div', {
        key: 'savebar',
        style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', margin: '4px 0 14px' },
      },
        Button({ primary: true, disabled: locked, onClick: () => { void save() } },
          busy === 'save' ? t('ui.whaleNewapi.saving') : t('ui.whaleNewapi.save')),
        Button({ danger: true, disabled: locked, onClick: () => { void reset() } },
          busy === 'reset' ? t('ui.whaleNewapi.resetting') : t('ui.whaleNewapi.reset')),
        Button({ disabled: locked, onClick: () => { void refresh() } },
          busy === 'refresh' ? t('ui.whaleNewapi.refreshing') : t('ui.whaleNewapi.refresh')),
        h('span', { style: { flex: '1 1 auto' } }),
        h('span', { style: { fontSize: 12, color: TOKEN.dim } }, t('ui.whaleNewapi.hintFilePriority')),
      )

      const noticeBox = notice === ''
        ? null
        : h('p', { key: 'notice', style: { ...HINT_STYLE, color: TOKEN.success, fontSize: 12, margin: '0 0 10px' } }, notice)

      const messageBox = message === ''
        ? null
        : h('p', { key: 'message', style: { ...HINT_STYLE, color: TOKEN.error, fontSize: 12, margin: '0 0 10px' } }, message)

      if (status === 'loading' && data === null) {
        return h('div', { style: { padding: '8px 2px 16px' } },
          h('p', { style: { fontSize: 13, color: TOKEN.dim } }, t('ui.whaleNewapi.loading')))
      }

      if (status === 'error' && data === null) {
        return h('div', { style: { padding: '8px 2px 16px' } },
          h('h3', { style: { fontSize: 16, margin: '0 0 8px' } }, t('ui.whaleNewapi.title')),
          h('p', { style: { ...HINT_STYLE, color: TOKEN.error, fontSize: 12 } }, t('ui.whaleNewapi.error') + '：' + message),
          Button({ onClick: () => { void refresh() } }, t('ui.whaleNewapi.retry')))
      }

      return h('div', { style: { padding: '4px 2px 16px' } },
        h('h3', { style: { fontSize: 16, margin: '0 0 6px' } }, t('ui.whaleNewapi.title')),
        h('p', { style: { ...HINT_STYLE, margin: '0 0 12px' } }, t('ui.whaleNewapi.intro')),
        noticeBox,
        messageBox,
        statusCard,
        connectionCard,
        credentialCard,
        widgetCard,
        syncCard,
        otherCard,
        saveBar,
      )
    }

    return {
      inject: ['slots'],

      apply(ctx) {
        // slots.inject 会等 settings.section 的声明落到 ledger 上再执行回调，
        // 所以设置外壳还没挂载时也不会注册失败。
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'whale-newapi-bridge',
          order: 46,
          label: () => t('ui.whaleNewapi.nav'),
        }, BridgeSettingsSection))
      },
    }
  },
})
