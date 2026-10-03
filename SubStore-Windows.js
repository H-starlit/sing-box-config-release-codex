// Windows 路线草稿的 Sub-Store 文件脚本：把组合订阅节点并入 Windows sing-box 模板。
// 输入使用 Release 下载的 Windows 严格 JSON config-windows.json；不要直接输入 JSONC 注释文件。
// 输出是完整 Windows 配置草稿，不代表已完成 Windows 端专项验证。
// 本脚本不读取本地文件系统；模板由 Sub-Store 文件脚本上下文通过 $content 或 $files 提供。
// Sub-Store 文件脚本接口说明：https://sub-store-org.github.io/doc/file/scripts

// 优先使用当前文件脚本收到的主内容；若没有主内容，则取文件列表的第一个文件。
// $content / $files 是 Sub-Store 文件脚本环境提供的全局变量。
const source = $content ?? $files[0]
if (typeof source !== 'string' || !source.trim()) {
  throw new Error('缺少 Windows 配置模板；请将 Release 中的 config-windows.json 作为脚本输入')
}

// Release 附件是工作流从 JSONC 生成的严格 JSON。
const config = JSON.parse(source)
if (!config || !Array.isArray(config.outbounds)) {
  throw new Error('模板缺少 outbounds 数组')
}

// 这里填写 Sub-Store 中已经存在的组合订阅名称，而不是订阅链接、文件名或节点名。
// produceArtifact 会按此名称读取组合订阅，并转换成 sing-box 格式的出站数组。
const collectionName = 'singbox合成'
if (!collectionName.trim()) {
  throw new Error('请先填写 Sub-Store 组合订阅名称')
}

// 从 Sub-Store 获取组合订阅的 sing-box 节点。
// type: collection 表示读取组合订阅；platform 指定输出平台；
// produceType: internal 表示在 Sub-Store 内部直接取得转换结果，不生成外部下载文件。
const produced = await produceArtifact({
  type: 'collection',
  name: collectionName,
  platform: 'sing-box',
  produceType: 'internal'
})
if (!Array.isArray(produced) || produced.length === 0) {
  throw new Error('组合订阅没有返回 sing-box 节点')
}

// 地区识别规则。节点标签去掉开头的 A- 或 B- 后，用这里的关键词判断地区。
// 每个地区配置两类正则：
// 1. 中文地名、旗帜或英文全称（忽略大小写）；
// 2. 独立的大写地区代码（大小写敏感），代码前不能紧邻大写字母，后面须为
//    字符串结尾、非字母字符或数字。这样可匹配 A-mitceUS-1TCP 中的 US，
//    同时避免把 UKR 中的 KR 误识别成韩国。
const regions = [
  { name: '美国', patterns: [/美|🇺🇸|united[ -]?states/i, /(?:^|[^A-Z])USA?(?=$|[^A-Za-z])/] },
  { name: '新加坡', patterns: [/新加坡|🇸🇬|singapore/i, /(?:^|[^A-Z])SG(?=$|[^A-Za-z])/] },
  { name: '台湾', patterns: [/台|🇹🇼|taiwan/i, /(?:^|[^A-Z])TW(?=$|[^A-Za-z])/] },
  { name: '日本', patterns: [/日|🇯🇵|japan/i, /(?:^|[^A-Z])JP(?=$|[^A-Za-z])/] },
  { name: '韩国', patterns: [/韩|🇰🇷|korea/i, /(?:^|[^A-Z])KR(?=$|[^A-Za-z])/] },
  { name: '香港', patterns: [/港|🇭🇰|hong[ -]?kong/i, /(?:^|[^A-Z])HK(?=$|[^A-Za-z])/] }
]

// A 提供商节点进入名称以“1”结尾的组，B 提供商节点进入以“2”结尾的组。
// 例如 A-...美国... → 美国1，B-...Japan... → 日本2。
const providers = [
  { prefix: 'A-', suffix: '1' },
  { prefix: 'B-', suffix: '2' }
]

// 组合订阅中预期存在的三个自建节点标签。
// 只有这三个标签会被加入“自建”组；其他没有 A-/B- 前缀的节点都会忽略。
const customTags = ['自建-VPS-WS', '自建-VPS-CFtunnel', '自建-VPS-直连']

// 先为 6 个地区 × 2 个提供商检查模板组，并建立“组标签 → 组对象及待加入节点”的映射。
// 组类型可以是手动 selector，也可以是测速 urltest；其余类型不接受。
const groups = new Map()
for (const region of regions) {
  for (const provider of providers) {
    const tag = `${region.name}${provider.suffix}`
    const matches = config.outbounds.filter(outbound => outbound && outbound.tag === tag)
    if (matches.length !== 1 || !['selector', 'urltest'].includes(matches[0].type)) {
      throw new Error(`模板缺少唯一的 selector/urltest 地区组：${tag}`)
    }
    // 当前模板应保留一个“直连”占位，避免 selector/urltest 的 outbounds 为空。
    // 若组已含真实节点，通常说明输入模板不是预期的公开底稿，拒绝覆盖它。
    if (!Array.isArray(matches[0].outbounds) || matches[0].outbounds.length !== 1 || matches[0].outbounds[0] !== '直连') {
      throw new Error(`地区组 ${tag} 已被修改，请使用公开模板作为输入`)
    }
    // 保留原组对象，以便后续替换 outbounds；members 暂存匹配到的订阅节点标签。
    groups.set(tag, { outbound: matches[0], members: [] })
  }
}

// existingTags 用于防止订阅节点标签与模板已有标签冲突，也防止订阅内部重复标签。
const existingTags = new Set(config.outbounds.map(outbound => outbound.tag))
// selected 保存最终允许并入模板的代理出站。
const selected = []
// customMembers 记录组合订阅里找到的自建节点标签。
const customMembers = []

// 逐个处理 Sub-Store 返回的 sing-box 出站。
for (const proxy of produced) {
  const tag = proxy && proxy.tag
  // 无标签的返回项无法稳定引用，忽略它。
  if (typeof tag !== 'string') continue

  // 自建节点按明确标签识别；普通订阅节点只接收 A- 或 B- 前缀。
  const isCustom = customTags.includes(tag)
  if (!isCustom && !/^[AB]-/.test(tag)) continue

  // 地区关键词只检查提供商前缀之后的文字，避免 A-/B- 本身参与地区匹配。
  const country = isCustom ? '' : tag.slice(2)
  const matchingRegions = isCustom ? [] : regions.filter(region => region.patterns.some(pattern => pattern.test(country)))

  // A 提供商的非目标地区节点不导入；B 提供商的非目标地区节点集中放入“韩国2”。
  // “韩国2”因此也可能是 B 提供商的剩余节点组，其中成员未必实际位于韩国。
  if (!isCustom && matchingRegions.length === 0 && !tag.startsWith('B-')) continue

  // 一个名称若同时命中多个地区，无法安全决定分组，要求先修正节点标签。
  if (matchingRegions.length > 1) {
    throw new Error('节点名称同时匹配多个地区，请调整地区标记')
  }

  // 代理出站必须有类型；标签必须唯一，且不能与模板中已有出站重名。
  if (typeof proxy.type !== 'string' || existingTags.has(tag)) {
    throw new Error('节点类型无效或标签重复，请检查组合订阅')
  }
  existingTags.add(tag)

  // 自建节点稍后统一写入“自建”组；A/B 节点按地区及提供商编号加入对应组。
  if (isCustom) {
    customMembers.push(tag)
  } else {
    const provider = providers.find(item => tag.startsWith(item.prefix))
    const groupTag = matchingRegions.length === 0 ? '韩国2' : `${matchingRegions[0].name}${provider.suffix}`
    groups.get(groupTag).members.push(tag)
  }

  // 若服务器地址是域名且节点没有自己的 domain_resolver，则补上 dns-ali。
  // 这样节点域名解析可以使用模板中的阿里 UDP DNS，不必依赖该节点自身先连通。
  // IPv4 地址和包含冒号的 IPv6 地址无需域名解析，因此不加此字段。
  const server = proxy.server
  const isIPv4 = typeof server === 'string' && /^\d{1,3}(?:\.\d{1,3}){3}$/.test(server)
  const isIPv6 = typeof server === 'string' && server.includes(':')
  if (typeof server === 'string' && server && !isIPv4 && !isIPv6 && !proxy.domain_resolver) {
    proxy.domain_resolver = { server: 'dns-ali', strategy: 'prefer_ipv4' }
  }
  selected.push(proxy)
}

// 组合订阅若提供了任意自建节点，则要求三个预期标签必须齐全，以免“自建”组被部分更新。
if (customMembers.length) {
  if (customMembers.length !== customTags.length) {
    throw new Error('组合订阅中的三个自建节点不完整')
  }
  const group = config.outbounds.filter(outbound => outbound && outbound.tag === '自建')
  // 模板中的自建组须唯一、类型须支持节点列表，且保留直连占位。
  if (group.length !== 1 || !['selector', 'urltest'].includes(group[0].type) || group[0].outbounds?.length !== 1 || group[0].outbounds[0] !== '直连') {
    throw new Error('模板中的自建组不是预期的 selector/urltest 直连占位')
  }
  // selector 有手动默认成员；urltest 自动测速，不使用 default 字段。
  group[0].outbounds = customTags.filter(tag => customMembers.includes(tag))
  if (group[0].type === 'selector') group[0].default = group[0].outbounds[0]
  else delete group[0].default
}

// 将已分类的订阅节点写入地区组。
for (const [tag, group] of groups) {
  if (group.members.length === 0) {
    // 该地区目前没有匹配节点时，保留模板的“直连”占位，避免输出空节点列表。
    continue
  }
  // 替换占位节点，而不是在占位后追加，以免“直连”被误当成地区代理成员。
  group.outbound.outbounds = group.members
  // selector 的默认值设为该组首个节点；urltest 不设默认值，保留其测速配置。
  if (group.outbound.type === 'selector') group.outbound.default = group.members[0]
  else delete group.outbound.default
}

// 把所有筛选出的订阅出站追加到模板末尾。业务组、DNS、TUN 和路由规则保持模板原样。
config.outbounds.push(...selected)
// Sub-Store 读取被赋值回 $content 的文本作为本脚本输出。
$content = JSON.stringify(config, null, 2)
