# Waypoint — 城市酒店点评平台 (TripAdvisor 风格)

按城市浏览酒店点评。首页选城市 → 城市页看该城市酒店（每页 20 个，可翻页）→ 详情页看点评 + AI 总结。每个酒店可点 👍 / 👎。后台可以看所有用户的投票数据、上传 CSV 批量导入酒店。

## 当前数据 & 排布规则（v2.1）

- **4 城 × 100 家酒店**（London / New York / Paris / Rome），全部同时具备 AI 摘要（平台 SEO 摘要）、酒店描述和图片，从原始 Travelers' Choice 数据里按三档抽取：低 ≤3.7 / 中 3.8–4.1 / 高 ≥4.2（TripAdvisor 评分普遍偏高，有 AI 摘要的酒店里 ≤3.7 已是最低的 10%）。低档取 33 家（不够就有多少取多少，纽约只有 24），其余在中、高之间平分；档内按评分逐级轮询、同级优先评论数多的。分布见 `data/rating_distribution.csv`。
- **城市内酒店随机排布，按参与者固定**：顺序 = 用参与者 ID + 城市名做种子的确定性洗牌。同一个参与者 ID 无论刷新、换设备，看到的顺序都一样；不同参与者看到的顺序不同。没有「AI 优先」「评分高低」等任何排序偏置。
- **没有 Sort 功能**：城市页不再有 Recommended / Highest rated / Most reviewed 排序栏。
- **不显示排名描述和获奖标记**：列表和详情页都不显示「#81 of 525 hotels in …」和「2026 WINNER」（数据仍保留在库里）。

## 页面质量约定（v2.2）

- **不编造数据**：页面上只显示 CSV 来源的真实字段（评分、评论数、价格区间、设施、AI 摘要、获奖标记）和参与者自己的操作结果。派生的「Rating breakdown」子评分、假的「N found this helpful」、AI 总结失败时的兜底假文案等已全部移除；未被渲染的旧组件（评论列表 / 写评论 / AI 总结卡）也已删掉，避免以后误上线。
- **不用假浏览器窗口 / 假代码编辑器外框**：页面中没有此类装饰。
- **交互组件状态齐全**（`src/App.jsx` 顶部 `GLOBAL_CSS` + 各组件）：
  - 按钮 / 卡片：默认、hover、active、focus-visible（键盘可达，卡片可用 Enter / 空格打开）、disabled。
  - 点赞 / 点踩：pending（转圈 + 禁用）→ 成功（"Saved"，1.8 s 后消失）/ 失败（回滚 + 红色提示 + Try again）。
  - Bookmark：同上（Saving… / Bookmark saved / 失败重试）。
  - 参与者 ID 弹窗：空值或非法字符校验、Starting… 加载态、服务器不可达错误 + 重试 / Continue anyway。
  - 首屏数据：API 失败时顶部红色横幅（Retry / 关闭），页面仍用内置数据可用。
  - 图片：加载中显示渐变占位，加载完淡入，失败回退渐变。
  - 住客引文（无 AI 摘要时）：加载中 / 失败重试 / 无内容。
- **移动端**：已在 320 / 360 / 390 / 414 / 768 / 1280 宽度下自动检查首页、城市页、详情页、弹窗，无横向滚动、无文字溢出（`.wp-row` 在 ≤600px 改为上下堆叠，标题用 clamp，长文本 `overflow-wrap: anywhere`）。
- **标题不用斜体**：全站 `h1–h4 { font-style: normal }`；唯一斜体是引文署名。
- 支持 `prefers-reduced-motion`。

## 实验条件：AI 摘要两个开关（v3.3）

后台「Study settings」页两个独立开关，保存即对之后打开网站的所有人生效：

- **AI summary in search page**（列表页）
- **AI summary in product page**（详情页）

两个都关时 API 里 `seo` 字段直接清空，浏览器拿不到摘要。被试点「同意」那一刻两个开关的状态会写进他的记录：后台 "AI in search / AI in product" 两列，`participants.csv` 和 `hotel_events.csv` 都有 `ai_summary_in_search_page`、`ai_summary_in_product_page`（yes/no）两列，分析时直接按这两列分组。**一批数据收集中途不要改开关。**

要同时跑多个条件：同一仓库在 Railway 部署多个服务，各自设环境变量 `AI_SUMMARY_SEARCH=on|off`、`AI_SUMMARY_PRODUCT=on|off`；设了环境变量的开关在后台会锁住。

两个都关时默认欢迎文案自动换成不提 AI 摘要的版本（自己改过文案的话不会自动换，注意检查）。

## 进入前的说明 / 知情同意（v3.0）

被试打开网站先看到一段说明文字（怎么用这个平台、记录什么数据），必须勾选「I have read the information above and agree to take part」才能点 Continue，然后再输入参与者 ID。同意时间按 ID 记录（后台 Agreed 列、CSV `consented` / `consent_time`）。

文字在后台「Welcome text」页修改，保存后下一个打开网站的被试就看到新版；空白行分段。留空并保存 = 恢复内置默认文案。文案存数据库（`settings` 表），不受 RESEED 影响。

## 后台「Participation」页（v3.0）

按被试为单位，每人一行：Liked（喜欢几家）、Disliked、Hotels viewed（看到过几家）、Clicked（点开几家）、Avg / hotel（对有停留的酒店，列表+详情的平均停留）、Total time（在网站的总时长）、Bookmarked（是否收藏网页）、Agreed（是否同意）、首次/最近出现时间。导出 `participants.csv` 同样的列。按酒店汇总的投票表和原始投票流水收在页面下方的折叠区里。

## 被试行为记录（v2.9）

每个被试（参与者 ID）× 每家酒店记录以下字段，后台「Participants」页可看，也可导出 CSV（`/api/admin/export/hotel_events.csv`）：

| 列 | 含义 |
|---|---|
| participant_id / hotel_id / hotel_name / city | 被试与酒店 |
| hotel_rating / hotel_review_count | 该酒店的评分、评论数 |
| list_views | 浏览次数：酒店卡片进入视口（≥50% 可见）的次数，滚走再滚回来算第二次 |
| clicks | 点击次数：打开详情页的次数 |
| vote | like / dislike / 空（当前状态） |
| vote_page | 这个 like/dislike 是在哪按的：list（搜索/列表页）或 detail（详情页） |
| list_dwell_seconds | 卡片在列表里可见的累计时长（标签页切走时不计） |
| detail_dwell_seconds | 停留在该酒店详情页的累计时长 |
| total_dwell_seconds | 上两项之和 |

实现：前端每秒给当前可见的卡片和打开的详情页各记 1 秒，每 5 秒批量发送；关闭/切走页面时用 `sendBeacon` 补发最后一段，所以关页面前的停留也不会丢。精度约 ±1 秒。

另外两个导出：`participants.csv`（每人一行）、`votes.csv`（每一次按下 like/dislike 的完整流水：participant_id, hotel, action=like/dislike, result=set/cleared（cleared = 再按一次取消）, page=list/detail, time）。

**后台改文案**：「Edit hotel text」页可按城市逐家修改「官方描述」和「AI summary」，保存即生效（列表显示描述第一句，详情页显示全文）。注意 `RESEED=1` 会把这些改动重置为 CSV 原值。

**数据持久化**：以上记录都存数据库；内存模式重启即清空，正式实验务必接 Postgres。

## 导航（v2.9.2）

- 前进（首页 → 城市 → 详情）会写入浏览器历史，所以系统自带的"返回"都能用：iPhone / Android 从左边缘右滑、Mac 触控板双指右滑、浏览器返回键、安卓返回键。
- 页面内也支持在任意位置向右滑（触屏 ≥90px）返回上一级。
- 页内 Back 按钮 = 浏览器返回，两者不会错位。

## 功能要点

- 城市列表每行：先显示 CSV「酒店描述」的**第一句**（到第一个句号为止，纯文本无标签；点进详情页看全文），下面是「AI summary」标签 + 平台 SEO 摘要；标签悬停/键盘聚焦显示提示 "This summary was created by AI, based on recent reviews."。详情页同样结构。没有摘要的才显示真实住客引文（GUEST 标签）。
- 每页 20 个 + 翻页（Prev / 1 2 3 … / Next）。
- 后台「管理酒店 / 排序」里的拖拽只影响后台列表本身，**不影响前台**（前台是按参与者固定的随机序）。
- **数据库（Postgres）**：酒店、点评、投票、排序都存库，刷新和重新部署都不丢。没配数据库时自动降级到内存模式（本地演示零配置）。
- **后台 `/admin`**（需密码）三个页：
  - 参与数据：总投票数、独立用户数、被投票酒店数、赞/踩总数、各酒店明细、每位用户最近投票记录。
  - 管理酒店 / 排序：拖拽调整每城酒店显示顺序。
  - 批量导入酒店：上传 Travelers' Choice 格式 CSV，自动清洗入库。

## 本地运行

```bash
npm install
npm run build

# 方式 A：零配置，内存模式（重启后数据清空，适合本地试）
npm start

# 方式 B：接 Postgres（数据持久）
export DATABASE_URL=postgres://user:pass@host:5432/dbname
export ADMIN_PASSWORD=你的后台密码          # 不设默认是 waypoint-admin
export ANTHROPIC_API_KEY=sk-ant-xxx        # 可选，开启真 AI 总结
npm start

# 前台 http://localhost:3000
# 后台 http://localhost:3000/admin  （用户名留空，密码 = ADMIN_PASSWORD）
```

首次连上空数据库时，会自动用 `src/cities.js` 里的种子数据（4 城 × 100 家）建表并灌入。

**已有数据库想换成新的 400 家数据**：部署时临时加环境变量 `RESEED=1`，启动会清空 hotels / reviews / cities 后重新灌入 `src/cities.js`（投票、收藏、浏览记录保留，按酒店 id 关联）。灌完记得把 `RESEED` 删掉，否则每次重启都会重置。

**改种子数据**：替换 `data/selected_hotels.csv`（需含 `城市代码` 列：london / new_york / paris / rome），然后
```bash
python3 build_data.py      # 需要 pandas；重新生成 src/cities.js
npm run build
```

## 酒店图片（本地下载一次，随代码提交）

```bash
npm install
npm run images          # 读取 src/cities.js 里每家酒店的 image_url，下到 public/images/hotels/<酒店id>.jpg
                        # 并发 2、每次间隔 0.5 s，399 张约 3–4 分钟；失败的记在 failed.tsv，重跑只补缺的
git add public/images/hotels && git commit -m "hotel images"
git push                # Railway 重新部署，图片随代码带上，运行时不请求任何第三方
```

- 服务端启动时扫描 `public/images/hotels/`，`/api/hotels` 只返回本地路径（`/images/hotels/...`，7 天缓存）；没图的酒店 `image` 为空，前端显示渐变占位。原始 `image_url` 不会发给浏览器。
- 这一步**没有**挂在 build 里，部署时不会自动去下（避免每次部署重复抓取）。只有你本地跑 `npm run images` 才会访问图片源。
- 可调：`CONCURRENCY=1 DELAY_MS=1000 npm run images`（更慢更保守）、`node scripts/download_images.js --force`（全部重下）、`IMAGE_UA="..."`（自定义 User-Agent，默认如实标明研究用途）。
- `IMAGE_REMOTE_FALLBACK=1`：让没下到图的酒店回退到原始 URL（参与者浏览器会直接请求图片源），默认关闭。

### 城市封面图

首页城市卡片和城市页顶部大图 = 该城市在 `data/selected_hotels.csv` 里**第 100 行**那家酒店的图片（`build_data.py` 把它记为 `coverHotelId`，`server.js` 映射到本地图片）。当前四个城市的封面酒店：London → a&o London Docklands Riverside；New York → The Washington Hotel NYC；Paris → Hotel Nation Montmartre；Rome → Radio Hotel Roma。想换成第 n 家：`COVER_ROW=n python3 build_data.py` 后重新 build。

### 图片目录可以跨版本复用

`public/images/hotels/` 只依赖酒店 id（由酒店名生成），跟网页代码无关。以后拿到新版本代码，把这个文件夹整个复制进新项目同样位置即可，不用重新下载。服务器启动时会打印 `[images] N local hotel images`，可以确认有没有带上。

## 部署到 Railway（带 Postgres）

1. 代码推到 GitHub。
2. railway.app → New Project → Deploy from GitHub repo。
3. 同一个 project 里 **+ New → Database → PostgreSQL**，Railway 会自动注入 `DATABASE_URL`。
4. Variables 加：`ADMIN_PASSWORD`（务必改），可选 `ANTHROPIC_API_KEY`、`ANTHROPIC_MODEL`。
5. Railway 自动 `npm install → npm run build → npm start`。
6. Settings → Networking → Generate Domain 拿公开网址。

数据在 Postgres 里，重新部署不会丢。**记得改 `ADMIN_PASSWORD`**，否则任何人都能进后台。

## 排序规则

- **前台**：城市内酒店顺序 = `shuffle(seed = hash(参与者ID + "::" + 城市key))`（Fisher–Yates + mulberry32，在 `src/App.jsx` 的 `seededShuffle`）。同一 ID 永远同一顺序，不同 ID 不同顺序；无任何排序按钮。
- **后台管理列表**：有 AI 摘要的在前 → 手动拖拽顺序 → 按 id 的稳定哈希。只影响后台。

## 批量导入的 CSV 格式

就是 **Travelers' Choice** 导出格式（中文表头）：必须包含
`酒店ID 酒店名称 评分 评论数 平台SEO摘要 用户评论摘录 用户评论用户名 地址 显示价格 价格区间最低 价格区间最高 酒店风格 亮点设施 旅行者之选 排名描述 纬度 经度 城市` 等列。

导入规则：按「有 AI 点评 → 有住客引文 → 获奖 → 高分 → 评论多」排序，默认每城最多 400 家。评分不设硬门槛（混合质量），只要求每行有有效酒店名、评分>0、至少 1 条评论。有 SEO 摘要的会带上 SEO；引文和用户名是 CSV 真实摘录。后台上传时可填城市显示名 / 国家 / city key，留空则从 CSV 的「城市」列自动生成。已存在酒店按名字去重后更新。

## 项目结构

```
├── server.js       # Express：数据 API + 投票 + AI 总结 + 后台(/admin) + CSV 导入 + 排序
├── db.js           # 数据层：Postgres 或内存降级；建表、seed、增删查、排序、投票统计
├── import_csv.js   # Travelers' Choice CSV 解析（build_data.py 的 JS 版）
├── build_data.py   # 从 data/selected_hotels.csv 生成 src/cities.js（需 pandas）
├── scripts/
│   └── download_images.js   # 本地跑一次：下载所有酒店 image_url 到 public/images/hotels
├── public/images/hotels/    # 下载好的图片，随代码提交
├── data/
│   └── selected_hotels.csv   # 4 城 × 100 家、全部带 AI 摘要、评分均匀分布的筛选结果
└── src/
    ├── main.jsx
    ├── App.jsx     # 全部前端 UI（数据从 /api 拉，cities.js 仅作离线兜底）
    └── cities.js   # 种子数据 CITIES + CITY_LISTINGS + CITY_REVIEWS（4 城 × 100）
```

## API 一览

- `GET /api/cities`、`GET /api/hotels?city=`、`GET /api/hotels/:id/reviews` — 前台数据（顺序由前端按参与者 ID 洗牌，API 返回顺序不重要）
- `GET /api/votes`、`POST /api/vote {hotelId,voterId,choice}` — 投票
- `POST /api/summarize {name,place,reviews[]}` — AI 总结
- `GET /api/admin/stats`（Basic auth）— 参与数据
- `GET /api/admin/hotels?city=`（Basic auth）— 后台酒店列表
- `POST /api/admin/hotel-text {id,about,seo}`（Basic auth）— 修改酒店描述 / AI 摘要
- `POST /api/track/event {pid,hotelId,type,n}`、`POST /api/track/batch {pid,items[]}` — 行为记录（type: seen | click | list_ms | detail_ms）
- `GET /api/admin/export/hotel_events.csv | participants.csv | votes.csv`（Basic auth）— 导出
- `POST /api/admin/reorder {city,orderedIds[]}`（Basic auth）— 保存排序
- `POST /api/admin/import`（Basic auth，multipart，字段 `file`）— CSV 导入

## 说明

- 评分、价格、设施、酒店描述（`about`）、SEO 摘要（`seo`）、住客引文来自 CSV 原始数据。`cities.js` 里仍保留派生的 `subRatings` 和 `rank` 字段，但页面不显示（前者是示意值，后者按需求隐藏）。
- 后台是 HTTP Basic 密码保护，够挡普通访问；要更强可自己加真正的登录 / SSO。
