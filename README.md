# 粉笔助手 · 解析与题目讨论

单文件油猴脚本 `fenbi-helper.user.js`（当前 `v1.2.0`），用于粉笔网页版作答解析页与「我的错题 / 背题」页面。它把原来的「自动展开答案解析 v3.0」与新增的「题目讨论」整合进同一个可扩展框架，并附带专注模式与统一设置面板。

适用页面：

- 解析页：`https://spa.fenbi.com/ti/exam/solution/*` 等 `*://*.fenbi.com/ti/*` 路径
- 错题本 / 背题页：`https://www.fenbi.com/spa/tiku/exam/error/practice/...`、`.../ti/memorize/...` 等 `fb-local-question` / `fb-recitatation-question` 题卡页面

---

## 1. 功能

| 模块 | 说明 |
| --- | --- |
| 自动展开解析 | 修复 Angular 折叠动画状态不同步（容器残留 `height: 0px; overflow: hidden`），进页面即完整展示解析；CSS `!important` 兜底 + JS 清除内联样式，由统一 `MutationObserver` 驱动 |
| 题目讨论 | 解析页：在 `.result-common-container` 内追加与「解析视频 / 文字解析 / 笔记」平级的可折叠 `section`；错题本 / 背题页：在 `fb-local-question` 题卡末尾追加独立区块。两者均懒加载评论 |
| 评论区交互 | 高赞 / 最新排序、分页「加载更多」、刷新、重试、复制单条评论、骨架屏 / 空态 / 错误态、评论数徽标 |
| 快捷入口 | 题目标题栏右侧增加气泡图标，点击展开讨论并滚动定位 |
| 批量操作 | 一键全部展开 / 全部收起讨论，加载并发限制为 3，避免请求风暴 |
| 专注模式 | 隐藏解析视频、推广位与答案统计卡 |
| 设置面板 | 功能开关、默认排序、每页条数、优质评论筛选、调试日志、实时诊断、恢复默认 |
| 其他 | 亮/暗主题自适应（复用粉笔 CSS 变量）、窄屏适配、`Alt+K` 打开面板、`Esc` 关闭、油猴菜单 3 项 |

评论区展示字段：头像、昵称、IP 属地、日期、五星评分、正文、点赞数；点赞数 >= 20 会标记「高赞」。

---

## 2. 安装

1. 安装 Tampermonkey / Violentmonkey / 脚本猫等用户脚本管理器。
2. 新建脚本并粘贴 `fenbi-helper.user.js`，或直接把该文件拖入扩展安装。
3. 弹出跨域授权时允许 `tiku.fenbi.com` 与 `ke.fenbi.com`（脚本已声明 `@connect`）。
4. **保持 `@run-at document-start`**，不要改成 `document-idle`。
5. **停用旧的「粉笔网 - 自动展开答案解析」脚本**，两者会重复处理折叠面板。

脚本头部声明：

```
@match        *://*.fenbi.com/ti/*
@match        https://www.fenbi.com/spa/tiku/*
@run-at       document-start
@grant        GM_xmlhttpRequest / GM_cookie / GM_getValue / GM_setValue / GM_registerMenuCommand / unsafeWindow
@connect      tiku.fenbi.com
@connect      ke.fenbi.com
```

若目标页面不在 `@match` 范围内，脚本不会运行；可自行追加 `@match`。脚本只识别解析页的 `app-result-common` 或错题本 / 背题页的 `fb-local-question` / `fb-recitatation-question`，其它页面会静默不注入。

---

## 3. 使用

- 每道题解析面板底部多出「题目讨论」栏：点标题栏展开 / 收起；「最热」「最新」切换排序；右侧圆形箭头刷新；底部「加载更多评论」翻页。
- 解析页题号右侧的气泡图标是快捷入口，点击会展开讨论并滚动到评论区；错题本 / 背题页没有标题栏，直接点题卡底部的「题目讨论」标题栏即可。
- 右下角圆形按钮打开助手面板，也可按 `Alt+K`；`Esc` 或点击面板外关闭。悬浮按钮会自动避开页面自带的「回到顶部 / 收起」按钮。
- 面板里「全部展开讨论 / 全部收起」用于整页复盘；展开后仍可逐题收起。
- 油猴菜单提供「打开粉笔助手设置」「全部展开题目讨论」「全部收起题目讨论」。

评论区只在首次展开时才请求数据，页面加载完成约 1.2 秒后会在后台批量预热整页题目的映射，因此多数题目点开即出结果。错题本接口的题号通常晚于 DOM 到达，点击时最多等待约 2.5 秒再发起评论请求。

---

## 4. 配置项

配置保存在 `GM_setValue`（降级 `localStorage`），键名 `fbh.settings.v1`；面板底部可「恢复默认设置」（会刷新页面）。

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `autoExpand` | `true` | 自动展开解析面板 |
| `comments` | `true` | 题目讨论总开关 |
| `quickEntry` | `true` | 题目标题栏气泡图标 |
| `focusMode` | `false` | 隐藏视频 / 推广 / 统计卡 |
| `sort` | `hot` | `hot` 按点赞数降序，`new` 按评论时间降序 |
| `pageSize` | `20` | 每次加载条数，可选 10 / 20 / 30 / 50 |
| `qualityOnly` | `false` | 只看优质评论：点赞 > 1、长度 > 8、不含问号 |
| `debug` | `false` | 控制台输出题号映射、题库配对与请求过程 |

---

## 5. 数据链路

```
解析页：questionKey（DOM: app-ti[data-question-key] / section-solution-*）
错题本 / 背题页：题卡无 key，按 DOM 顺序对齐接口下发的题号
  → 数字题号 tikuId（优先级从高到低）
      1. 题目接口 URL 的 questionIds（/tikuApi/{prefix}/universal/auth/...?questionIds=…）
      2. 题目接口响应中「含 key 的题目对象」顺序（solutions / questions / exercise / getSolution）
      3. user-answers?ids=…
      4. tiku_episodes_with_multi_type 请求 URL 的 tiku_ids
      5. report_display_cards 请求体中的 questionIds
      6. 解析页题目 key 末段的 base36 编码（例：3_1_4efej → 7391611）
  → episodeId
      ke.fenbi.com/api/gwy/v3/episodes/tiku_episodes_with_multi_type
      ?tiku_ids=…&tiku_prefix=…&tiku_type=…
  → 评论列表
      ke.fenbi.com/ipad/gwy/v3/comments/episodes/{episodeId}?…&len=…&start=…
      备用：/android/{prefix}/v3/comments/episodes/…、/android/gwy/v3/comments/episodes/…
```

- 评论响应结构：`{ code, msg, total, datas: [] }`；`datas[]` 用到 `comment`、`likeCount`、`nickName`、`avatar`、`createdTime`、`ipLocation`、`fiveGradeScore` 等字段。总数字段是 **`total`**（部分版本为 `totalCount`，两者都兼容）。
- episode 响应结构实测为 `data[题号] = { "0": { id: episodeId, ... } }`，即**数字键对象而非数组**，解析时会遍历数字键并跳过 `teacher` 之类的无关对象。
- 请求通道：优先页面 `fetch(url, { credentials: 'include' })`（实测粉笔允许跨域且自动携带登录态，不依赖 `@connect` 授权）；失败后降级 `GM_xmlhttpRequest`（先不带自定义头，再尝试 `GM_cookie` 取得的 Cookie）。
- 所有请求均为 **GET 只读**，脚本不点赞、不发帖、不修改任何作答数据。

---

## 6. 重要注意点 / 已知限制

1. **不是每道题都有评论。** 粉笔公开评论挂在「解析课 episode」上，而非题目本身。实测题目维度的 `comments/questions/...` 一类接口均返回 404；示例练习的 15 道题里只有第 3 题 `3_1_3bfs0` 有解析课与 5 条评论，错题本同理。无 episode 的题会显示「这道题还没有公开讨论」并带「重新加载」按钮，这是**正常空态**，不是加载失败。
2. **`routecs` 不等于 `tiku_prefix`。** URL 里的 `routecs=xingce` 只是路由参数；`tiku_prefix` 与 `tiku_type` 必须配对，用错会返回 `code=-1 tiku_prefix 错误` 或全空桶。脚本会优先尝试实测有效组合（`sydw/5`、`gwy/1`、`xingce/5`、`sydw/1`），再从页面响应里提取的 `tikuPrefix` 补足候选，最多试探 8 组。
3. **保持 `document-start`。** 旁路捕获必须早于页面自身的数据请求；改成 `document-idle` 会丢掉最可靠的题号来源（虽然还有 base36 兜底）。
4. **接口属于站点内部接口，非公开 API。** 参数、字段、题库前缀随时可能随前端版本变化；脚本做了多候选与降级，但无法保证长期有效。若粉笔改版导致失效，需要重新抓包核对第 5 节的链路。
5. **页面本身需要登录。** `ke.fenbi.com` 的 episode 映射与评论接口无登录态也可访问，但 `tiku.fenbi.com` 的练习数据兜底接口需要登录态（未登录返回 401 / 453 `无效DeviceSid`）。新版页面带 `deviceId` 校验，脚本会复用页面自身请求的参数。
6. **首次展开可能等待 1–2 秒**：若题库前缀未命中，脚本要依次试探若干 `(prefix, type)` 组合；预热完成后后续题目会快很多。
7. **与旧脚本冲突**：旧「自动展开答案解析」请停用；多个同类脚本同时挂载会重复修改同一容器。
8. **主题**：样式使用粉笔 CSS 变量并带亮/暗 fallback，跟随页面主题；窄屏（<= 640px）会隐藏排序按钮，悬浮面板宽度自适应。
9. **作用域**：解析页与错题本 / 背题页分别识别 `app-result-common` 与 `fb-local-question`；切题 / Angular 重绘后由统一观察器补回注入节点；刷新页面是最稳妥的恢复方式。
10. **错题本的题号靠顺序对齐。** 错题本题卡没有 `data-question-key`，脚本按接口下发的 `questionIds` / 题目对象顺序与 DOM 题卡索引对齐。若错题本改版、分页大小变化或接口顺序改变，可能出现题号错位（表现为评论内容与题目不符）；可先刷新页面，或在助手面板查看映射数量与调试日志。
11. **悬浮按钮自动避让。** 右下角按钮会检测 `.toTopActions`、`.ant-back-top-inner` 等页面固定按钮并上移，窗口 resize / 滚动 / DOM 变化时重算；无冲突时恢复默认 `96px`。若页面用了其它类名导致仍重叠，可反馈类名补充。

---

## 7. 常见问题排查

| 现象 | 含义 | 处理 |
| --- | --- | --- |
| 「这道题还没有公开讨论」 | 本题没有解析课 episode，平台没有可展示的评论 | 正常；可点「重新加载」或看其它题 |
| 「未定位到本题题号，请确认已登录且页面加载完成后重试」 | 页面数据请求未捕获、练习 key 异常或未登录 | 刷新页面；确认保持 `document-start`；打开调试日志看映射数量 |
| 错题本里点开一直「未定位到本题题号」 | 错题本题目接口尚未返回，或接口结构变化 | 等页面加载完再点；刷新；开调试日志看「题号映射」数量 |
| 错题本评论内容与题目不匹配 | 题号顺序对齐失败（分页 / 改版） | 刷新页面；把页面 URL 与助手面板映射数量反馈 |
| 悬浮按钮仍与回到顶部重叠 | 页面按钮用了未覆盖的类名 | 反馈该按钮的 class / DOM 结构，补充避让选择器 |
| 「讨论小节映射失败：HTTP xxx / 题库参数不匹配」 | episode 接口请求失败或题库前缀组合有变 | 看助手面板「接口诊断」行；允许跨域授权；把具体文字反馈以便更新配对表 |
| 「评论暂时没能加载」+ 具体错误 | 网络 / 接口 / CORS 异常 | 点「重新加载」；必要时开「调试日志」查控制台 |
| 看不到「题目讨论」栏 | 总开关被关、页面路径不在 `@match`、或 DOM 结构已变 | 检查面板里的「题目讨论」开关与页面 URL |
| 解析仍然折叠 | `autoExpand` 被关闭，或页面改版换了容器类名 | 打开开关；改版需更新 `.result-common-container-toggle` 选择器 |

诊断入口：

- 助手面板状态行显示「题号映射 / 小节映射 / 已加载题数」「题库前缀 / 练习 key / 旁路捕获次数」以及接口诊断信息。
- 控制台可访问 `__FBH__`（同时挂在脚本与页面 `window`）：`{ version, settings, data, views, expandAllComments }`。常用：
  - `__FBH__.data.episodes`、`__FBH__.data.keyToId`、`__FBH__.data.orderIds`
  - `__FBH__.data.prefixCandidates`、`__FBH__.data.lastEpisodeError`
  - `__FBH__.views.size`（当前已挂载的评论区数量）
- 打开「调试日志」后，控制台前缀 `[粉笔助手]` 会输出题号顺序、题库配对命中与请求失败原因。

---

## 8. 隐私与边界

- 脚本只在粉笔自有域名（`tiku.fenbi.com` / `ke.fenbi.com`）之间发起 GET 请求，不向第三方上传任何数据。
- 请求会携带当前浏览器对粉笔域的登录态 Cookie（由浏览器 / 扩展自动携带，或降级时显式附加）；不会读取或导出 Cookie 内容。
- 不做任何写操作：不点赞、不发表评论、不改动答案与笔记。
- 代码为单文件、无外部依赖、无 `@require`，可直接审阅。

---

## 9. 开发与验证

单文件分层组织，新增功能只需往 `FEATURES` 里追加一个实现 `apply(ctx)` / `onDom(ctx)` 的对象：

```
基础设施   Settings / EventBus / DOM 调度 / UI Kit(h) / HTTP
数据服务   DataService：旁路捕获 → 兜底请求 → 映射与缓存
功能模块   FEATURES：autoExpand / comments / focusMode / quickEntry
控制入口   悬浮面板 + 油猴菜单 + 快捷键
```

- CSS 与 DOM 类名统一前缀 `fbh-`，避免与页面样式冲突。
- DOM 调度使用单个 `MutationObserver` + 140ms 防抖；插入节点用 `data-fbh-key` 等标记保证幂等。
- 本地校验：`node --check fenbi-helper.user.js`。
- 已做过的验证：`node --check` 与 IDE 诊断通过；用 jsdom 加载解析页快照（15 题）与错题本快照（10 题）并接入真实接口，确认 25 个评论区全部注入、真实评论渲染（各 5 条）、排序与面板交互；用真实 Chrome 加载两类快照渲染并截图，均无页面错误；悬浮按钮在模拟回到顶部按钮存在时为 `244px`，移除后恢复 `96px`。
- 说明：未在「已登录的现有浏览器窗口」里直接联调（该窗口未开放远程调试端口、Chrome Cookie 库被独占）；但评论链路接口本身不需要登录态，已用真实接口完成等价验证。

---

## 10. 版本记录

- **1.2.0**：支持「我的错题 / 背题」页面（`fb-local-question` / `fb-recitatation-question` 题卡）；题号优先取题目接口 URL 的 `questionIds` 与响应中的题目对象顺序，并兼容 `user-answers?ids=`、`report_display_cards`；错题页题卡末尾注入独立评论区；悬浮按钮自动避让 `.toTopActions` / `.ant-back-top-inner`，无冲突时恢复默认位置。
- **1.1.0**：修复题库前缀与 `tiku_type` 配对（`routecs` 不等于 `tiku_prefix`）；兼容数字键结构的 episode 桶；题号增加 base36 推导；请求改为 `fetch` 优先并复用页面 `deviceId` 参数；兼容 `total` 字段与 `android` 评论接口；透传真实失败原因；无解析课时改为友好空态；消除状态容器残留留白。
- **1.0.0**：合并原「自动展开答案解析 v3.0」，新增题目讨论、批量展开、专注模式、设置面板与模块化框架。
