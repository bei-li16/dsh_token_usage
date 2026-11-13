/**
 * Standalone locale-alignment check for dsh-usage-ledger/client.js: the zh and
 * en dictionaries must expose exactly the same key set (zh-TW reuses zh, so it
 * needs no check). client.js is a single browser artifact that cannot export;
 * this script parses the two `const zh|en = { … }` blocks with a regex, which
 * is robust enough because keys are plain identifiers and values never contain
 * an `identifier:` sequence at line start. Run: node dsh-usage-ledger/src/client/i18n.check.mjs
 */
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../../client.js', import.meta.url), 'utf8')

function keysOf(name) {
  const m = src.match(new RegExp(`const ${name} = \\{([\\s\\S]*?)\\n    \\}`))
  if (!m) throw new Error(`${name} dictionary not found`)
  // keys are ASCII identifiers; no dictionary value contains an `ident:` sequence
  return [...m[1].matchAll(/\b([A-Za-z_]\w*):/g)].map((x) => x[1])
}

const zh = keysOf('zh')
const en = keysOf('en')
const onlyZh = zh.filter((k) => !en.includes(k))
const onlyEn = en.filter((k) => !zh.includes(k))
if (onlyZh.length || onlyEn.length || zh.length !== en.length) {
  console.error('i18n.check FAILED', { zhCount: zh.length, enCount: en.length, onlyZh, onlyEn })
  process.exit(1)
}
console.log(`i18n.check: zh/en dictionaries aligned (${zh.length} keys each).`)
