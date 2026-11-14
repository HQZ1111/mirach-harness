import type { TranslationOverrides } from './define-locale'

/**
 * 连接器页面的中文文案。
 *
 * **为什么单独一个文件**：上游所有中文 catalog（zh.ts / zh-hant.ts）都没有
 * `connectorsPage` 这一段——英文有 11 KB，中文一个键都没有。上游的
 * `defineLocale` 是基于英文深度合并，所以缺的键会**静默显示英文**：整页
 * 中文界面里突然出现一整页英文（实测：Connectors tab 全英文）。
 *
 * 这是 AGENTS.md 规矩 1 的已知例外——上游 i18n 缺口按正规三件套补齐：
 * `types.ts` 已有 `connectorsPage` 契约（不需要动），en.ts 是原文，这里是
 * 中文译文。函数型键保持与英文完全相同的签名与插值位置，只翻译字面文字。
 */
export const zhConnectorsPage: NonNullable<TranslationOverrides['connectorsPage']> = {
  title: '连接器',
  searchPlaceholder: (count: number) => `在 ${count} 个应用中搜索`,
  filterCategory: '分类',
  categoryAll: '全部分类',
  uncategorised: '未分类',

  residencyLocal: '在此设备上',

  segment: {
    all: '全部',
    available: '可用',
    connected: '已连接',
    off: '已关闭'
  },

  group: {
    connected: '已连接',
    connectedNote: '失效的连接排在前面。',
    available: '可用',
    off: '已关闭',
    offNote: '登录信息会保留。'
  },

  card: {
    kindManaged: '托管',
    kindCatalog: 'MCP · 目录',
    kindCustom: 'MCP · 自定义',
    kindPlugin: (plugin: string) => `MCP · 插件 ${plugin}`,
    inCatalog: '在 Hermes 目录中',
    hostedTwin: '有托管版本可用',
    alsoLocal: '也在此设备上运行',
    open: (name: string) => `打开 ${name}`,
    turnServerOn: (name: string) => `开启 ${name}`,
    turnServerOff: (name: string) => `关闭 ${name}`,
    state: {
      accessExpired: '授权已过期',
      available: '可用',
      connected: '已连接',
      connecting: '正在连接',
      connectionUnknown: '状态未知',
      couldNotConnect: '无法连接',
      offByYourOrganisation: '已被你的组织关闭',
      offForYou: '已为你关闭',
      serverConnecting: '正在连接…',
      serverError: '出错',
      serverNeedsAuth: '需要授权',
      serverOff: '已关闭',
      serverOn: '已开启',
      serverOnUnused: '已开启，未使用'
    },
    fact: {
      tools: (count: number) => `${count} 个工具`,
      toolsOff: (count: number) => `${count} 个工具已关闭`,
      toolsOn: (count: number) => `${count} 个工具已开启`,
      toolsSomeOn: (total: number, on: number) => `${total} 个工具，${on} 个已开启`
    },
    verb: {
      authenticate: '授权',
      connect: '连接',
      install: '安装',
      openLogs: '打开日志',
      reconnect: '重新连接',
      stopWaiting: '停止等待',
      tryAgain: '重试',
      turnBackOn: '重新开启'
    },
    reason: {
      finishSignIn: '请在浏览器中完成登录。',
      reconnect: '重新连接以继续使用此应用。',
      serverError: '服务器拒绝了连接。',
      serverNeedsAuth: '登录后此服务器才能响应。'
    }
  },

  page: {
    loading: '正在读取目录与此设备上的服务器',
    emptyTitle: '这里还没有应用。先在此设备上添加一个服务器。',
    noMatchTitle: '没有匹配的应用',
    noMatchBody: '没有匹配项。让 Hermes 指向你自己的 MCP 服务器即可添加。',
    clearSearch: '清除搜索',
    hostedFailedTitle: '无法访问托管应用。',
    hostedFailedBody: '此设备上的服务器不受影响，仍在运行。没有任何东西被关闭。',
    retry: '重试',
    matchesElsewhere: (count: number) => `另有 ${count} 项匹配在其他分组中。`,
    showAllMatches: '显示全部匹配',
    segmentNoMatch: (segment: string) => `「${segment}」下没有匹配，已显示全部匹配。`,
    freeTierNote: '登录之前，连接只保留在此设备上。',
    signInLine: '登录 Nous 以使用托管应用。',
    signIn: '登录',
    managedUnavailable: '此账户暂时无法使用托管应用。',
    writeFailed: '该更改未能保存。',
    refreshFailed: '工具列表未能刷新。',
    disconnectNoAccount: '这里没有可断开的 Hermes 账户。请刷新页面后重试。',
    disconnectRefused: 'Nous 目前无法移除这个登录。请改用开关关闭该应用，或稍后再试。'
  },

  add: {
    action: '添加自己的',
    title: '连接到自定义 MCP',
    hint: '会在此设备的 mcp.json 中新增一条记录',
    pasteLabel: '粘贴命令或片段',
    pastePlaceholder: 'npx -y @modelcontextprotocol/server-filesystem /path/to/dir',
    pasteNoMatch: '这里读不出服务器信息。请改填下方字段。',
    name: '名称',
    nameTaken: '该名称已被使用。',
    type: '类型',
    typeStdio: 'STDIO',
    typeHttp: '流式 HTTP',
    command: '启动命令',
    args: '参数',
    addArg: '+ 添加参数',
    envVars: '环境变量',
    addEnvVar: '+ 添加环境变量',
    passthrough: '环境变量透传',
    addPassthrough: '+ 添加变量',
    cwd: '工作目录',
    url: 'URL',
    headers: '请求头',
    addHeader: '+ 添加请求头',
    auth: '认证',
    authNone: '无',
    authOauth: 'OAuth',
    authBearer: 'Bearer 令牌',
    keyPlaceholder: 'KEY',
    valuePlaceholder: 'value',
    removeRow: '删除此行',
    editJson: '编辑 mcp.json',
    saveFailed: '该服务器未能保存。'
  },

  dialog: {
    disconnect: '断开连接',
    disconnectTitle: (name: string) => `断开 ${name}？`,
    disconnectBody: 'Hermes 将不再以此账户身份操作。你随时可以重新连接。',
    menuRefreshTools: '刷新工具',
    moreActions: '更多操作',
    removeServerTitle: (name: string) => `移除 ${name}？`,
    removeServerBody: '该记录会从此设备的 mcp.json 中删除。其他内容不会被删除。',
    appSwitch: (name: string) => `Hermes 可以使用 ${name}`,
    waysTitle: (name: string) => `${name} 的运行位置`,
    wayNotConnected: (name: string) => `尚未连接。请在浏览器中登录 ${name}。`,
    wayHosted: '托管',
    bothOn: (name: string) => `两者都已开启，Hermes 会把每个 ${name} 工具看到两次。`,
    turnOffLocal: '关闭本地服务器',
    providedByPlugin: (plugin: string) => `由插件 ${plugin} 提供`,
    openPlugins: '打开插件标签页',
    nousLine: 'Nous 应用跟随你的账户，而不是配置文件。',
    rulesReadOnly: '目前无法更改规则。',
    rulesAppOff: (name: string) => `开启 ${name} 才能更改它的工具。`,
    rulesSignIn: '登录后才能更改 Hermes 在此可执行的操作。',
    orgNote: (count: number) => `你的组织关闭了 ${count} 个工具。`,
    orgLink: '打开连接器管理后台',
    connectEnded: '登录未完成。',
    connectOpenAgain: '重新打开链接',
    tokensPerCall: '每次调用的 token 数',
    usesPerMonth: '30 天内使用次数',
    advanced: '高级',
    advancedHint: 'mcp.json 记录与日志'
  },

  tools: {
    title: '工具',
    notInstalledBody: '在此设备上安装后即可查看它带来的工具。',
    summaryTitle: (name: string) => `Hermes 可以用 ${name} 做什么`,
    summaryPreviewTitle: (name: string) => `连接后 Hermes 可以用 ${name} 做什么`,
    summaryCount: (count: number) => `${count} 个工具`,
    summaryAllTools: '全部工具',
    summaryOther: '其他',
    allToolsSwitch: '开启或关闭所有工具',
    summaryAllOn: '全部开启',
    summarySomeOn: (on: number, total: number) => `${total} 个中 ${on} 个已开启`,
    summaryOff: '已关闭',
    showAllTools: (count: number) => `显示全部 ${count} 个工具`,
    showSummary: '显示摘要',
    facetSwitch: (facet: string) => `开启或关闭「${facet}」类工具`,
    moreHints: (count: number) => `+${count}`,
    staleSignIn: '登录后可读取最新的工具列表。',
    searchCountPlaceholder: (count: number) => `在 ${count} 个工具中搜索`,
    toolList: (name: string) => `${name} 的工具`,
    categorySelect: (count: number) => `${count} 个分类`,
    showDeprecated: (count: number) => `显示 ${count} 个已弃用项`,
    hideDeprecated: (count: number) => `隐藏 ${count} 个已弃用项`,
    quickReadOnly: '只读',
    quickNoDestructive: '关闭破坏性工具',
    quickEverythingOn: '全部开启',
    lockedHint: '已被你的组织关闭',
    turnToolOn: (tool: string) => `开启 ${tool}`,
    turnToolOff: (tool: string) => `关闭 ${tool}`,
    showDetails: (tool: string) => `查看 ${tool} 的作用`,
    hideDetails: (tool: string) => `收起 ${tool} 的作用`,
    noMatch: '没有工具符合这些筛选条件。',
    loading: '正在读取工具列表',
    unavailableLine: '工具列表不可用。',
    needsAuthTitle: (name: string) => `登录 ${name} 以读取它的工具。`,
    needsAuthBody: '登录信息只保留在此设备上，不会外传。',
    retry: '重试',
    goneTitle: (name: string) => `${name} 已离开目录。`,
    goneBody: 'Hermes 无法再调用它。该行会保留到你移除为止，不会有东西凭空消失。',
    remove: '移除',
    offTitle: (name: string) => `${name} 已关闭。`,
    offBody: '用上方的开关开启它，即可读取它带来的工具。',
    signedOutTitle: '登录 Nous 以读取工具列表。',
    signedOutBody: '你在此设备上的服务器不受影响。',
    conflictTitle: '你编辑期间有人改动了这条规则。',
    conflictBody: (theyOff: number, theyOn: number) => {
      const they = [
        theyOff > 0 ? `关闭了 ${theyOff} 个你已开启的工具` : '',
        theyOn > 0 ? `开启了 ${theyOn} 个你已关闭的工具` : ''
      ].filter(Boolean)

      return `${they.length > 0 ? `对方${they.join('，并')}。` : ''}你的修改仍留在屏幕上，没有任何内容被写入。`
    },
    conflictReload: '载入对方的版本',
    conflictSave: '用我的版本覆盖',
    saveFailed: '这些工具规则未能保存。',
    footerDirty: (off: number, backOn: number) =>
      `${off} 个工具已关闭，${backOn === 0 ? '没有' : backOn + ' 个'}重新开启`,
    discard: '放弃修改',
    save: '保存更改',
    saving: '正在保存…'
  },

  // 工具行的标签：短到不会把行撑宽。
  vocabulary: {
    facetRead: { label: '读取', long: '从此应用读出数据，不做任何更改。' },
    facetWrite: { label: '写入', long: '在此应用中创建或更改内容。' },
    facetDestructive: { label: '破坏性', long: '可能永久删除此应用中的内容。' },
    facetUnclassified: { label: '影响未知', long: '应用没有说明这个工具做什么。' },
    hintReadOnly: { label: '只读', long: '该工具声明自己只读。' },
    hintCreate: { label: '创建', long: '产生新内容。' },
    hintUpdate: { label: '更新', long: '更改已存在的内容。' },
    hintDelete: { label: '删除', long: '移除内容。' },
    hintDestructive: { label: '破坏性', long: '它造成的更改在此无法撤销。' },
    hintIdempotent: { label: '可重复', long: '运行两次与运行一次效果相同。' },
    hintOpenWorld: { label: '外部', long: '会访问此应用之外的内容。' }
  }
}
