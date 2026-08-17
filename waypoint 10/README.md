# Waypoint — 城市酒店点评平台 (TripAdvisor 风格)

按城市浏览酒店点评。首页选城市 → 城市页看该城市酒店（TripAdvisor 风格排名列表，每页 20 个，可翻页）→ 详情页看点评 + Claude 生成的 AI 总结。每个酒店可点 👍 / 👎。后台可以看所有用户的投票数据、拖拽调整酒店显示顺序、上传 CSV 批量导入酒店。

## 功能要点

- **有 AI 点评（SEO）的酒店优先**：前台城市列表和后台列表都把有平台 SEO 摘要的酒店排在最前；城市列表每行有 SEO 就显示 SEO（AI 标签），没有才显示真实住客引文（GUEST 标签），文字完整不截断。
- **每城最多 200 家酒店**，每页 20 个 + 翻页（Prev / 1 2 3 … / Next）。
- **后台拖拽排序**：在「管理酒店 / 排序」里选城市，拖动每一行调整前台显示顺序，点「保存顺序」写库。有 AI 点评的仍自动排最前，其余按你拖的顺序。
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

首次连上空数据库时，会自动用 `src/cities.js` 里的种子数据（8 城，每城最多 200 家）建表并灌入。

## 部署到 Railway（带 Postgres）

1. 代码推到 GitHub。
2. railway.app → New Project → Deploy from GitHub repo。
3. 同一个 project 里 **+ New → Database → PostgreSQL**，Railway 会自动注入 `DATABASE_URL`。
4. Variables 加：`ADMIN_PASSWORD`（务必改），可选 `ANTHROPIC_API_KEY`、`ANTHROPIC_MODEL`。
5. Railway 自动 `npm install → npm run build → npm start`。
6. Settings → Networking → Generate Domain 拿公开网址。

数据在 Postgres 里，重新部署不会丢。**记得改 `ADMIN_PASSWORD`**，否则任何人都能进后台。

## 排序规则

前台城市列表、后台管理列表统一按：
1. **有 AI 点评（SEO 摘要）的排最前**
2. 然后按后台手动拖拽的顺序（sort_order）
3. 再按评分高→低、评论数多→少

前台的「Highest rated / Most reviewed」排序键会在「SEO 优先」的前提下再排。

## 批量导入的 CSV 格式

就是 **Travelers' Choice** 导出格式（中文表头）：必须包含
`酒店ID 酒店名称 评分 评论数 平台SEO摘要 用户评论摘录 用户评论用户名 地址 显示价格 价格区间最低 价格区间最高 酒店风格 亮点设施 旅行者之选 排名描述 纬度 经度 城市` 等列。

导入规则：按「有 AI 点评 → 有住客引文 → 获奖 → 高分 → 评论多」排序，默认每城取前 200 家。评分不设硬门槛（混合质量），只要求每行有有效酒店名、评分>0、至少 1 条评论。有 SEO 摘要的会带上 SEO；引文和用户名是 CSV 真实摘录。后台上传时可填城市显示名 / 国家 / city key，留空则从 CSV 的「城市」列自动生成。已存在酒店按名字去重后更新。

## 项目结构

```
├── server.js       # Express：数据 API + 投票 + AI 总结 + 后台(/admin) + CSV 导入 + 排序
├── db.js           # 数据层：Postgres 或内存降级；建表、seed、增删查、排序、投票统计
├── import_csv.js   # Travelers' Choice CSV 解析（build_data.py 的 JS 版）
├── build_data.py   # 从 CSV 生成 src/cities.js 种子数据（改种子时用，需 pandas）
└── src/
    ├── main.jsx
    ├── App.jsx     # 全部前端 UI（数据从 /api 拉，cities.js 仅作离线兜底）
    └── cities.js   # 种子数据 CITIES + CITY_LISTINGS + CITY_REVIEWS（8 城 × 最多 200）
```

## API 一览

- `GET /api/cities`、`GET /api/hotels?city=`、`GET /api/hotels/:id/reviews` — 前台数据（酒店按 SEO 优先 + sort_order 排好序返回）
- `GET /api/votes`、`POST /api/vote {hotelId,voterId,choice}` — 投票
- `POST /api/summarize {name,place,reviews[]}` — AI 总结
- `GET /api/admin/stats`（Basic auth）— 参与数据
- `GET /api/admin/hotels?city=`（Basic auth）— 后台酒店列表
- `POST /api/admin/reorder {city,orderedIds[]}`（Basic auth）— 保存排序
- `POST /api/admin/import`（Basic auth，multipart，字段 `file`）— CSV 导入

## 说明

- 评分、排名、价格、设施、SEO 摘要、住客引文来自 CSV 原始数据；子评分（Location / Cleanliness 等）为按总分派生的示意值。
- 后台是 HTTP Basic 密码保护，够挡普通访问；要更强可自己加真正的登录 / SSO。
