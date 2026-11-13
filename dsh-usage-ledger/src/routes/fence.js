// fence.js — /usage-ledger/api 的浏览器信任围栏，dsh-token-total trust-fence.ts
// 的零依赖 JS 移植（镜像官方 /api 网关围栏 isTrustedApiRequest）。请求仅在以下
// 三路校验全部通过时放行：
//
// 1. Host 围栏（DNS-rebinding 防御）：Host 头必须指向 loopback、trustedHosts
//    条目、或本监听 socket 的 bind 地址。无端口的 trustedHosts 条目匹配该主机名
//    的任意端口；带显式端口的条目只匹配该 host:port；两边都经 WHATWG URL 规范化
//    比较，大小写与冗余默认端口不影响判定。
// 2. cross-site 围栏：浏览器标注的 sec-fetch-site: cross-site 一律拒收（不看 Origin）。
// 3. Origin 围栏：带 Origin 时必须恰等于 Host authority；字面量 "null"（沙箱
//    iframe、file: 页面）是 opaque origin，拒收。无 Origin 放行——Host 围栏已经约束了请求。
//
// 三个信任输入每次请求实时读取（trust()），因为宿主行决定各自挂在哪个 provider 上。
// 请求面保持结构化：{url?, method?, headers, [Symbol.asyncIterator]}，不 import node:http 类型。

/** WHATWG URL hostname 是否为 loopback authority：localhost、[::1]、或 127/8 的 IPv4。 */
export function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return (
    parts.length === 4
    && parts[0] === '127'
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  )
}

/** 原始 Host 头值（小写化），缺失时为 null。 */
export function parseHostHeader(req) {
  const header = req.headers.host
  const value = Array.isArray(header) ? header[0] : header
  if (!value) return null
  return value.trim().toLowerCase()
}

/** 裸 authority 的规范化 URL（hostname 小写、默认端口剥离、IPv6 加括号），
 *  无法解析时为 undefined。scheme 决定剥离哪个默认端口，与官方围栏一致。 */
function parseAuthority(authority, scheme = 'http:') {
  try {
    // http: 与 https: 是 WHATWG "special schemes"：解析要么得到非空 hostname，要么抛错。
    return new URL(`${scheme}//${authority}`)
  } catch {
    return undefined
  }
}

/** 已解析 trustedHosts 条目的规范形：无端口时为 `hostname`，否则 `hostname:port`。
 *  端口由两种 special scheme 下的 URL 解析共同判定（二者默认端口不同，故 :80 与
 *  :443 仍算显式），绝不从原始字符串判断。 */
function canonicalAuthority(entry, entryUrl) {
  // 能在 http 下解析的 authority 在 https 下不可能失败。
  const port = entryUrl.port !== '' ? entryUrl.port : new URL(`https://${entry}`).port
  return port === '' ? entryUrl.hostname : `${entryUrl.hostname}:${port}`
}

/** 请求 authority 是否匹配某条 trustedHosts 条目。显式端口条目精确匹配；
 *  无端口条目匹配该 hostname 的任意端口（CLI 为 IP 字面量 LAN 服务派生的形状，
 *  绑定端口可能是 OS 分配的）。 */
function isTrustedAuthority(hostUrl, trustedHosts, protocol) {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry, protocol)
    if (entryUrl === undefined) return false
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host
  })
}

/** 表示"所有接口"的 bind 写法。"每个接口"不是浏览器拨号的那个单一 authority，
 *  不作为 bind 地址放行（其真实可达性由 trustedHosts 的 LAN 字面量覆盖）。 */
const WILDCARD_BIND_ADDRESSES = new Set(['0.0.0.0', '::', '::ffff:0.0.0.0'])

/** 请求 authority 是否就是本监听 socket 的 bind 地址。浏览器拨该字面量时会原样
 *  放进 Host；该字面量不是 rebinding 目标，放行它不多授予任何东西（Origin 与
 *  cross-site 校验照常），且它不进 trustedHosts。与无端口条目一样忽略端口匹配，
 *  并忽略 %zone id（接口选择器，不是地址文本）。 */
function isBindAddressAuthority(hostUrl, bindHost) {
  if (bindHost === undefined) return false
  const zoneAt = bindHost.indexOf('%')
  const address = (zoneAt === -1 ? bindHost : bindHost.slice(0, zoneAt)).toLowerCase()
  if (WILDCARD_BIND_ADDRESSES.has(address)) return false
  const bindUrl = parseAuthority(address.includes(':') ? `[${address}]` : address)
  return bindUrl !== undefined && bindUrl.hostname === hostUrl.hostname
}

/** 在 Origin 的 HTTP(S) scheme 下比较 Host，使默认端口一致规范化（传输层在 HTTPS
 *  代理后可能仍是 HTTP）。
 *  @param {string} origin 逐字的 Origin 头值
 *  @param {string} host   已通过 Host 围栏的逐字 Host 头值
 *  @returns 仅当 Origin 是本监听者自己的 http(s) authority 时为 true。 */
function isSameAuthorityOrigin(origin, host) {
  let originUrl
  try {
    originUrl = new URL(origin)
  } catch {
    // opaque "null"（沙箱 iframe、file: 页面）在这里抛错。
    return false
  }
  // 只有 http(s) 能指向本监听者：其余 scheme（file:、ftp:）在此失败，
  // 不会只靠 hostname 匹配。
  const scheme = originUrl.protocol === 'https:' ? 'https:'
    : originUrl.protocol === 'http:' ? 'http:'
      : undefined
  if (scheme === undefined) return false
  const hostUrl = parseAuthority(host, scheme)
  return hostUrl !== undefined && originUrl.host === hostUrl.host
}

/**
 * 创建信任围栏。
 * @param {() => {trustedHosts: string[], bindHost?: string, protocol?: 'http:'|'https:'}} trust
 *   实时信任输入：trustedHosts = 本部署服务的额外 authority；bindHost = 监听 socket
 *   的绑定地址（任意端口放行）；protocol = 监听协议（默认按 http: 处理）。
 * @returns {{isTrusted(req: object): boolean}}
 */
export function createTrustFence(trust) {
  return {
    isTrusted(req) {
      const { trustedHosts, bindHost, protocol = 'http:' } = trust()
      // 1. Host 围栏，对每个请求生效：纯 HTTP 下浏览器读请求既不挂 Origin 也不挂
      // Fetch-Metadata，无标记的请求仍可能是 rebinding 浏览器读；Host 是 rebinding
      // 唯一无法伪造的头。
      const host = parseHostHeader(req)
      if (host === null) return false
      const hostUrl = parseAuthority(host, protocol)
      if (hostUrl === undefined) return false
      if (!isLoopbackHostname(hostUrl.hostname)
        && !isTrustedAuthority(hostUrl, trustedHosts ?? [], protocol)
        && !isBindAddressAuthority(hostUrl, bindHost)) return false
      // 2. cross-site 围栏：现代浏览器在每次 fetch 上标注发起方关系；
      // 显式 cross-site 标记一律拒收。
      const site = req.headers['sec-fetch-site']
      if ((Array.isArray(site) ? site[0] : site) === 'cross-site') return false
      // 3. Origin 围栏：带 Origin 时必须恰等于本 authority。
      // 字面量 "null" 会在下面的 URL 解析失败并被拒收。
      const origin = req.headers.origin
      const originValue = Array.isArray(origin) ? origin[0] : origin
      if (originValue === undefined) return true
      return isSameAuthorityOrigin(originValue, host)
    },
  }
}
