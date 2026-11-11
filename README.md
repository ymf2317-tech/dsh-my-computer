# dsh-my-computer

DSH Web 右栏的「我的电脑」面板：**在手机上浏览和操作整台 Windows 电脑的磁盘**（C:、D: 及以后插上的任何盘），不受当前会话工作区限制。

场景很具体：人不在电脑旁边，只用手机通过 DSH 网页远程管理文件。所以要的是「把资源管理器映射过来」，而不是「看看当前 workspace 里有什么」。

[![npm](https://img.shields.io/npm/v/dsh-my-computer)](https://www.npmjs.com/package/dsh-my-computer) ![platform](https://img.shields.io/badge/platform-Windows-4d6bfe) ![license](https://img.shields.io/badge/license-MIT-green)

```bash
# 在 profile 目录（~/.dsh/profiles/web）里
pnpm add dsh-my-computer
# 然后把 "dsh-my-computer" 加进 package.json 的 dsh.profile.bundles，重启 dsh web
```

> 已实测环境：DSH 0.2.2-rc.1 + Windows 10/11 + Node 24，宿主侧 12 条路由 + 客户端右栏 tab 均正常。

---

## 1. 为什么不用现成的 `@lolkda/dsh-file-manager`

那个包是很好的接口范本（本插件的注册写法就是照它抄的），但它写死了只能在 Linux 跑：

- `package.json` 里 `"os": ["linux"]`；
- 启动时会打开固定的 root 并做身份校验，在 Windows 上直接进入 `UNSUPPORTED_PLATFORM` 降级态，所有路由都只回答「不可用」；
- 它的协议是 v2 的 `op` 信封（`entries.list` / `text.read` 之类），参数里带 `rootId`，整套是围绕「一个已校验的 root」设计的——而我们要的恰恰是「没有 root、全盘随便走」。

所以本插件重写了 host 与 client 两层，只借它的**形状**（`ctx.connection.fetch.register` 的注册方式、`cordis.patch.yml` 的挂载方式、客户端 bundle 的 `window.__ModuleLoader__.load` 格式），不借它的领域模型。

---

## 2. 结构

```
dsh-my-computer/
├── package.json          # dsh.bundle.patch + dsh.client 声明
├── cordis.patch.yml      # insert: [{ id: my-computer, name: dsh-my-computer }]
├── lib/
│   ├── index.js          # host 半区：ESM cordis 插件，注册 12 条 HTTP 路由（零依赖，只用 node: 内置）
│   ├── zip.js            # 整目录打包：自己写的流式 zip 写入器（零依赖，走 node:zlib）
│   └── client.js         # 客户端 bundle：window.__ModuleLoader__.load({id, factory}) 格式，手写 React.createElement
├── tools/
│   ├── smoke.mjs         # host 冒烟测试（伪造 ctx，直接打路由，含 zip 解包校验）
│   ├── client-check.mjs  # 客户端 bundle 自检（语法/注册/渲染状态）
│   └── right-tab-check.mjs # 右栏 tab 三件套注册轨迹检查
└── README.md
```

- 纯 JS，**没有构建步骤、没有 TypeScript、没有 JSX**。改完直接重启 dsh web 就生效。
- host 侧不用任何 npm 依赖（`node:fs` / `node:fs/promises` / `node:path` / `node:stream` 就够）。
- client 侧只用宿主注入的 `react`，样式用运行时注入的 `<style>`。

---

## 3. 路由表

### 3.1 关于前缀：`/my-computer/` → 实际是 `/api/my-computer/`

设计上路由叫「`/my-computer/xxx`」，但 DSH 的精确 fetch 路由**只能挂在 `/api` 共享通道下**——`connection.fetch.register` 内部用 `endpointFromPath('/api', route.path)` 校验，路径不以 `/api/` 开头的直接抛异常（见 `dsh-client-connection/lib/index.js:973` 的 `assertFetchRoute`）。

所以真实路径是 **`/api/my-computer/xxx`**，前端 `fetch('/api/my-computer/...')` 同源相对路径。

这不是妥协，是必须：那条通道在分发前会检查 `peer.principal.kind === 'owner'`（`createSharedFetchHandler`），也就是**只有通过 DSH 鉴权的浏览器会话才能进来**。反过来，如果改用 `ctx.webServer.register({kind:'prefix'})` 拿原生 `/my-computer` 前缀，那条路**不查 cookie、不查 Host/Origin**（`dsh-host-webserver` 的注释写得很清楚：`This method checks no cookie, Host, or Origin`），等于把整块磁盘裸奔在 3081 端口上。全盘读写的东西不能这么干。

### 3.2 表

| 逻辑路由 | 真实路径 | 方法 | 说明 |
| --- | --- | --- | --- |
| `/drives` | `GET /api/my-computer/drives` | GET | 探测 A:–Z:（`statSync("X:\")` 成功即列出），`statfsSync` 给 total/free，`accessSync` 给 writable。返回 `{ok,drives:[{letter,label,total,free,ok,writable}]}` |
| `/list` | `GET /api/my-computer/list?path=D:\foo` | GET | 列目录。目录在前、`localeCompare(zh-Hans-CN, numeric)` 排序。返回 `{ok,path,parent,entries:[{name,path,kind,size,mtime,ext,targetKind,statError}],count,total,free}`；盘符根 `parent:null` |
| `/read` | `GET /api/my-computer/read?path=&maxBytes=` | GET | 文本预览，默认 ≤512KB、硬上限 8MB。UTF-8 优先，失败退 GB18030，再失败判二进制。返回 `{ok,path,size,mtime,truncated,encoding,text}` |
| `/write` | `POST /api/my-computer/write` | POST | `{path,text}` 覆盖写：先写同目录 `.dsh-mc-write-*.tmp` 再 rename。返回 `{ok,path,size,mtime}` |
| `/download` | `GET /api/my-computer/download?path=` | GET | 单文件流式下载，`Content-Disposition: attachment`（含 `filename*=UTF-8''`，中文名不乱码）。给目录会 400 `IS_DIRECTORY`，提示改用下一个 |
| `/download-dir` | `GET /api/my-computer/download-dir?path=` | GET | **整目录打包成 zip 流式下发**，不落临时文件、不占内存。响应头带 `x-zip-entries` / `x-zip-bytes`。空目录 400 `ZIP_EMPTY`，条目 >20000 或 >3.9GB 在发头之前就 413，整盘根 403 |
| `/upload` | `PUT /api/my-computer/upload?path=<目录>&name=<文件名>[&overwrite=1]` | PUT | 原始二进制 body 流式落盘（`requestBody:'streaming'`），先写 `.dsh-mc-upload-*.tmp` 再 rename。同名 409，`overwrite=1` 才覆盖 |
| `/mkdir` | `POST /api/my-computer/mkdir` | POST | `{path:父目录,name}`，不带 `recursive`，重名 409 |
| `/rename` | `POST /api/my-computer/rename` | POST | `{path,name}`，同目录改名，目标存在 409 |
| `/delete` | `POST /api/my-computer/delete` | POST | `{paths:[...],confirm:true}`，递归删除，**没有 `confirm:true` 就 400**；拒绝删盘符根；部分失败返回 207 + `failed[]` |
| `/move` | `POST /api/my-computer/move` | POST | `{sources:[...],targetDir}`，剪切粘贴；跨盘 `EXDEV` 自动退化成 复制+删除 |
| `/health` | `GET /api/my-computer/health` | GET | 自检：插件版本、node 版本、平台 |

错误统一是 `{ok:false,error:{code,message}}` + 合适状态码（400/403/404/409/415/422/423/500/507/207）。所有 handler 都包在 try/catch 里，**任何异常都不会抛给宿主**，只会变成一条 `console.warn` 和一段 JSON。

### 3.3 路径校验（有意做得松）

只校验三件事：非空、是绝对 Windows 路径（`X:\` 或 `\\server\share`）、不含 NUL。**不做 workspace 门卫**——用户要的就是全盘权限，设门卫反而把「远程救火」的场景卡死。真正的边界交给 Windows 自己的 ACL：没权限就返回 `PERMISSION_DENIED`。

### 3.4 整目录打包（`lib/zip.js`）

没在 `/download` 上加个 `?zip=1`，而是单独一条路由、单独一个模块，因为「打包」的坑和「读一个文件」完全不同：

- **先扫再发**：`scanDir()` 先走一遍目录树（只 `stat`、不读内容），拿到条目清单与总字节数，**在写响应头之前**就判断「空目录 / 条目超 20000 / 超 3.9GB」。所以客户端拿到的是 JSON 错误，而不是下到一半的残包。
- **小文件先试压**：≤8MB 的文件读进内存，`zlib.deflateRawSync` 压得动就 DEFLATE、压不动就 STORE（jpg/mp4/zip/pdf 这类直接跳过压缩），CRC 与大小在写本地头之前就已知。
- **大文件走数据描述符**：>8MB 直接 STORE 流式吐出，边读边算 CRC，写完补 16 字节 data descriptor（通用标志 bit 3）。内存恒定，不落临时文件。
- **中文名**：所有条目带 UTF-8 标志（bit 11），解压不乱码；目录条目带尾部 `/`，空目录也能还原。
- **符号链接跳过**：不跟随，避免环和跨盘。
- **不支持 Zip64**：超阈值明确报 `ZIP_TOO_LARGE` / `ZIP_TOO_MANY_ENTRIES`，不静默截断。

已验证：Windows 自带 `Expand-Archive` 能直接解开（含中文文件名、空目录、11MB 大文件），解出来的文件 sha256 与源文件一致；`tools/smoke.mjs` 还会自己解析中央目录逐条比对 CRC。

---

## 4. 面板

注册两处，都是 DSH 公开槽位：

- **右栏 tab（主要入口）**：`ctx.sidebarRightTabs.register({ id: 'my-computer', kind: 'my-computer', title, guide: [...] })`，正文挂 `sidebar.right.pane.tab[key=my-computer]`，chip 标题挂 `sidebar.right.pane.tab.title`。`guide` 数组决定它是否出现在右栏「+」菜单里——**少了 guide 就不显示**，这是第一版踩过的坑。
- **左栏面板（附加入口）**：`sidebar.panellist`（`id: my-computer`，`order: -5`）+ `main[key=my-computer]`。手机上它是整屏打开，桌面上进主栏。

面板本体长这样：

- **顶部**：盘符行（chip，显示可用空间，一键切换）+ 面包屑（每一级可点）+ 刷新
- **路径框**：粘贴 `D:\dsh-workspace\vault` 回车直接跳转（远程操作的主力功能）
- **列表**：图标 + 名称 + 大小/时间两行式；点目录进入，点文件开预览抽屉；每行右侧 下载（文件）/ 打包（目录 zip）/ 剪切 / 改名 / 删除
- **打包下载**：目录行点 🗜 直接下 `<目录名>.zip`，走浏览器原生下载（不把整包攒成 blob，手机上下几百 MB 也不会崩标签页）
- **剪切 / 粘贴**：行内 ✂ 或选中多项后点「✂ 剪切 N 项」→ 进目标目录点「📋 粘贴到此处」，走 `POST /move`（同盘 rename，跨盘自动退化成 复制+删除）。剪切板只在内存里，刷新即失，避免误粘
- **多选**：行首复选框 + 「全选」，选中后出现「删除 N 项」/「剪切 N 项」
- **筛选**：一个输入框过滤当前目录（手机上一个目录几百个文件时很有用）
- **底部**：共 N 项、可用/总容量、已选数、上传进度
- **底部工具条**：新建文件夹 / 上传（`<input type=file multiple>`，逐个 PUT，遇到同名弹「覆盖上传」确认）/ 全选 / 删除
- **预览抽屉**：图片直接显示；文本可编辑 + 保存（显示编码、是否截断）；其它类型给「下载」按钮
- **错误**：红条显示在面板里，从不静默失败
- **主题**：颜色全部走 `var(--dsw-alias-*)`，并在 `@media (prefers-color-scheme: dark)` 里给了暗色兜底，不会出现「白天一片死白、夜里闪瞎眼」

窄屏优先：`@media (max-width:420px)` 压缩内边距与字号；根容器带 `min-height:calc(100dvh - 96px)` 兜底（DSH 主视图容器不保证有确定高度，只写 `height:100%` 会塌成 0）。

---

## 5. 安装

插件是 profile bundle：装包 + **登记到 `dsh.profile.bundles` 白名单** + 重启 dsh web，三步缺一不可（漏了白名单，下次 `dsh plugin install` 会把它 prune 掉）。

### 方式 A：npm（推荐）

```powershell
cd C:\Users\Administrator\.dsh\profiles\web
pnpm add dsh-my-computer
# 编辑 package.json："dsh": { "profile": { "bundles": [ ... , "dsh-my-computer" ] } }
```

### 方式 B：github: 直装

```powershell
cd C:\Users\Administrator\.dsh\profiles\web
pnpm add github:ymf2317-tech/dsh-my-computer
# 同样要登记 dsh.profile.bundles
```

### 方式 C：link 到本地工作区（开发态，改代码立即生效，和 dsh-a2a-panel / dsh-memo-plus 一致）

```powershell
cd C:\Users\Administrator\.dsh\profiles\web
pnpm add link:D:/dsh-workspace/packages/dsh-my-computer
```

然后编辑 `C:\Users\Administrator\.dsh\profiles\web\package.json`，把包名加进白名单数组（**这一步不能漏**，否则下次 `dsh plugin install` 会把 node_modules 里的副本 prune 掉）：

```json
"dsh": { "profile": { "bundles": [ ... , "dsh-my-computer" ] } }
```

### 方式 D：vendor + file:（和 dsh-header-dock、dsh-mobile-fixes 一致，抗 prune）

```powershell
robocopy D:\dsh-workspace\packages\dsh-my-computer C:\Users\Administrator\.dsh\profiles\web\vendor\dsh-my-computer /E
cd C:\Users\Administrator\.dsh\profiles\web
pnpm add file:vendor/dsh-my-computer
```

同样要往 `dsh.profile.bundles` 里加 `"dsh-my-computer"`。

### 方案 C：`dsh plugin` CLI

如果这个版本的 CLI 支持装本地目录（`dsh plugin --profile web add <path>` 之类），用它装完**仍要检查** `dsh.profile.bundles` 里有没有 `dsh-my-computer`。

### 重启

```powershell
# 计划任务 DSH-Web 跑的是 D:\dsh\start-dsh.bat
schtasks /End /TN DSH-Web
schtasks /Run  /TN DSH-Web
# 或直接看日志确认起来了
Get-Content D:\dsh\dsh.log -Tail 40
```

启动日志里应该能看到一行：

```
[dsh-my-computer] 已注册 12 条路由：GET /api/my-computer/health, GET /api/my-computer/drives, ...
```

（这行是 `ctx.logger.info`，`console.log` 也会打一份。）

### 装完怎么确认

1. **路由挂上了**：`curl -i http://127.0.0.1:3081/api/my-computer/health` → 期望 **401**（未鉴权被 DSH 挡掉，说明路由确实挂在受保护的 `/api` 通道上）。
2. **真数据**：在已登录的浏览器地址栏直接开 `https://<你的 DSH 地址>/api/my-computer/health` 和 `.../drives`，应该看到 JSON。
3. **面板**：web 界面右栏会出现「我的电脑」图标；点开应看到 C:/D: 两个 chip 和 D:\dsh-workspace 的列表。

### 卸载

```powershell
cd C:\Users\Administrator\.dsh\profiles\web
pnpm remove dsh-my-computer
# 再从 dsh.profile.bundles 里删掉 "dsh-my-computer"
# 方案 B 还要删 vendor\dsh-my-computer
```

重启 dsh web。路由与面板一起消失，磁盘上没有任何残留（插件不写任何配置文件）。

---

## 6. 安全模型（别随手放宽）

三层，缺一不可：

1. **通道鉴权**：路由挂在 `/api` 共享通道，DSH 在分发前要求 `peer.principal.kind === 'owner'`。没通过 DSH 登录的请求到不了 handler。
2. **监听地址**：dsh web 只 bind `127.0.0.1`，外部经 `tailscale serve` / `--public-url` 转发。「本机 loopback」由监听地址保证，handler 里不再判断 socket 地址（判断了也会因为反代而误判）。
3. **跨站防护**：带 `Origin` 的请求，其 host 必须与 `Host` 头一致，否则 403。防的是「别的网站用 form 提交打到这台机器」。比较时会把 `:443` / `:80` 这类默认端口归一化掉（有的反代会给 Host 补端口）。万一某天反代改写了 Host 导致误判，可以设环境变量 `DSH_MY_COMPUTER_ALLOW_CROSS_ORIGIN=1` 关掉这一层（只关跨站判断，通道鉴权仍在）。

**因此这个面板等于「谁登进了你的 DSH，谁就能读写你的整块磁盘」。** 这是需求本身决定的（全盘远程管理），但请确认 DSH 那个 tailscale 地址没有被公开分享。如果哪天要收窄，最省事的做法是给 `apply(ctx, config)` 加白名单根目录参数。

---

## 7. 自检脚本

两个脚本都不需要 dsh 宿主，直接跑：

```powershell
cd D:\dsh-workspace\packages\dsh-my-computer
node tools/smoke.mjs          # host：12 条路由 + 正常/错误路径 + zip 解包比对
node tools/client-check.mjs   # client：bundle 形状 + slots 注册 + 四个渲染状态
node tools/right-tab-check.mjs # client：右栏 tab 三件套（sidebarRightTabs + pane.tab + title）注册轨迹
```

`tools/smoke.mjs` 的做法：伪造最小 ctx（`effect` / `connection.fetch.register` / `logger`），`import` `lib/index.js` 调 `apply()`，把注册出来的每个 handler 用真 `Request` 打一遍（URL 形状与 DSH 桥接层一致：`http://dsh.internal` + 注册路径 + query），断言状态码、JSON 外形与磁盘真实状态。临时文件都在 `D:\dsh-workspace\tmp\mycomp-smoke\`，跑完删除。

`tools/client-check.mjs` 的做法：用 `new Function` 执行 `lib/client.js`（伪造 `window.__ModuleLoader__` 与最小 `document`），拿到 factory 返回值，检查 `apply`/`inject`、两个 slot 的 id/order/label/key 是否自洽，然后用**真实的 react 18** 加一个手搭的最小 hook dispatcher 把面板渲染四遍（空态 / 列表态 / 删除确认 / 图片预览），确认不抛异常且节点数合理。它不执行 `useEffect`，所以不会发任何网络请求。

---

## 8. 已知限制 / 没被验证的部分

- **已实测（2026-11-11）**：Linux 容器与本机之外的 Windows 宿主上原生跑通，右栏「+」菜单出现「我的电脑」，盘符、路径跳转、上传下载、改名删除、文本编辑全部可用。客户端注册失败时会把原因挂在 `window.__MYCOMP_ERR`，方便定位。
- **`dsh.client.inject` 故意留空 `[]`**：`slots` 服务在任何客户端插件里都直接可用（同 profile 里工作的 `dsh-a2a-panel` 就是 `inject: []`），而写一个本机不存在的模块 id 会让整个 bundle 加载失败。
- **整目录打包有限制**：超 20000 个条目或 3.9GB 会直接 413（不支持 Zip64，请分批下）。大文件是 STORE 不压缩（保速度与内存恒定），所以下大电影不会变小。
- **上传没有字节进度**：只有「上传中 n/总数」。要字节级百分比得换 XMLHttpRequest。
- **删除不进回收站**：`fs.rm` 是硬删除，所以面板做了两步确认 + 后端要求 `confirm:true` + 拒绝删盘符根。
- **大文件文本编辑**：`/read` 只给前 512KB。截断状态下保存会用编辑器里的内容覆盖整个文件——面板在截断时给了红字提示，但这是真实风险，编辑大文件请先下载。
- **NTFS 权限/长路径/只读盘**：没有做特殊处理，出错就按 `PERMISSION_DENIED` / `IO_ERROR` 报给面板。超过 260 字符的路径依赖 Node 的长路径支持，未实测。
- **剪切板只在内存里**：刷新/关面板就没了（故意这样，避免手滑把文件粘到奇怪的地方）。跨目录批量移动请用「选中 → 剪切 → 粘贴」。

---

## 9. 版本

0.2.0 —— 整目录打包下载（`GET /download-dir`，自研流式 zip，不落临时文件）+ 面板接上剪切/粘贴（走 `POST /move`）+ 客户端与宿主版本对不上时给提示而不是 404。

0.1.0 —— 首个公开版本。11 条路由 + 右栏 tab 面板（盘符切换 / 面包屑 / 路径粘贴跳转 / 列表 / 多选删除 / 新建 / 上传 / 下载 / 改名 / 预览与文本编辑），Windows 原生，跨盘符、不受会话工作区限制。
