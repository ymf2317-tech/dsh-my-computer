// 检查客户端半区在真实 ctx 形状下会注册哪些东西（不渲染，只用假 ctx 捕获注册）
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

let registration
const fakeWindow = {
  __ModuleLoader__: {
    load(reg) {
      registration = reg
    },
  },
}
const fakeDocument = {
  head: { appendChild() {} },
  createElement() {
    return { setAttribute() {}, appendChild() {}, style: {}, textContent: '' }
  },
  querySelector() {
    return null
  },
  getElementById() {
    return null
  },
}
globalThis.window = fakeWindow
globalThis.document = fakeDocument

new Function('window', 'document', src)(fakeWindow, fakeDocument)

if (!registration) throw new Error('没有捕获到 __ModuleLoader__.load 注册')
console.log('module id =', registration.id)

// react 桩：apply 阶段只注册组件，不真的渲染
const fakeReact = {
  createElement: (type, props, ...kids) => ({ type, props, kids }),
  Fragment: 'Fragment',
  useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
  useEffect: () => {},
  useMemo: (f) => f(),
  useCallback: (f) => f,
  useRef: (v) => ({ current: v }),
}
const clientPlugin = registration.factory((spec) => {
  if (spec === 'react') return fakeReact
  if (spec === 'react/jsx-runtime') return { jsx: fakeReact.createElement, jsxs: fakeReact.createElement }
  throw new Error('unexpected external: ' + spec)
})

console.log('exports:', Object.keys(clientPlugin).join(', '))
console.log('inject:', JSON.stringify(clientPlugin.inject))

const seen = []
function makeSlots() {
  return {
    inject(name, cb) {
      seen.push('slots.inject:' + name)
      const dispose = cb()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    register(opts, comp) {
      seen.push('slots.register:' + opts.name + (opts.key ? '[key=' + opts.key + ']' : opts.id ? '[id=' + opts.id + ']' : ''))
      if (typeof comp !== 'function' && comp !== null) throw new Error('component 不是函数: ' + opts.name)
      return () => {}
    },
  }
}

const disposers = []
const ctx = {
  slots: makeSlots(),
  effect(fn) {
    const d = fn()
    if (typeof d === 'function') disposers.push(d)
    seen.push('effect')
  },
  inject(deps, cb) {
    seen.push('ctx.inject:' + deps.join('+'))
    const child = {
      slots: ctx.slots,
      sidebarRightTabs: {
        register(def) {
          seen.push(
            'sidebarRightTabs.register(id=' + def.id + ', kind=' + def.kind + ', guide=' + (def.guide ? def.guide.length : 0) + ')',
          )
          if (!def.id || !def.kind) throw new Error('id/kind 缺失')
          if (typeof def.title !== 'function') throw new Error('title 必须是函数')
          return () => {}
        },
      },
    }
    const d = cb(child)
    if (typeof d === 'function') disposers.push(d)
  },
}

clientPlugin.apply(ctx)

console.log('\n--- 注册轨迹 ---')
for (const s of seen) console.log('  ' + s)
console.log('\n__MYCOMP_ERR =', globalThis.window.__MYCOMP_ERR || '(无错误)')

const must = [
  'sidebarRightTabs.register(id=my-computer',
  'slots.inject:sidebar.right.pane.tab',
  'slots.register:sidebar.right.pane.tab[key=my-computer]',
  'slots.inject:sidebar.right.pane.tab.title',
  'slots.register:sidebar.right.pane.tab.title[key=my-computer]',
]
let bad = 0
console.log('\n--- 断言 ---')
for (const m of must) {
  const ok = seen.some((s) => s.startsWith(m.replace('[key=my-computer]', '')) || s === m || s.startsWith(m))
  console.log((ok ? '  ✓ ' : '  ✗ ') + m)
  if (!ok) bad++
}
console.log(bad === 0 ? '\n全部通过' : '\n失败 ' + bad + ' 项')
process.exit(bad === 0 ? 0 : 1)
