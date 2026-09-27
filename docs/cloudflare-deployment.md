# Cloudflare 部署

采用 Workers Static Assets + Cloudflare Access。页面保持现有功能；仅增加发布工具和服务端登录保护。

## 准备

```bash
nvm use
npm ci
npm test
npm run check:deploy
```

需要 Node.js 22+。`check:deploy` 只生成脱敏示例并做本地打包检查，不上传内容。
开发浏览仍可用原来的 `python3 -m http.server 8000`。

发布资产固定为 `.work/cloudflare/assets/`。构建器仅复制 HTML、app.js、D3 及其许可证、示例 JSON 和 robots.txt；
只有显式执行 `npm run build:private` 才加入 `data/awards-timeline.json`。
每次构建先清空旧资产，防止从真实数据切换到示例时残留数据。
数据须通过结构和逐笔数量校验，清单与 SHA-256 写入资产目录之外的 `.work/cloudflare/manifest.json`。
不要将仓库根目录、整个 `.work/` 或整个 `data/` 作为发布目录。

## 首次上线顺序

1. `npm run cf:login`，在浏览器中登录自己的 Cloudflare 账户；用 `npm run cf:whoami` 确认。
2. `npm run build:demo` 后运行 `npx wrangler deploy`，创建不含真实数据的 Worker。
   默认配置为空，页面会返回 503；这是尚未配置登录保护的预期状态。
3. 在 Cloudflare 启用 Zero Trust 的免费方案，开启 One-time PIN 登录。
   在 Workers & Pages → `vesting-timeline` → Access，选择 **Protect this Worker / All traffic**。
   只允许自己的完整邮箱，不使用 Everyone、Bypass 或整域邮箱规则。建议会话有效期 1 小时。
4. 将根目录 `wrangler.jsonc` 复制为根目录 `wrangler.local.json`（已忽略，不入库）。填写 `vars`：

   | 配置 | 值 |
   | --- | --- |
   | `TEAM_DOMAIN` | `https://<Zero Trust 团队名>.cloudflareaccess.com` |
   | `POLICY_AUD` | Access 应用的 Application Audience (AUD) Tag |
   | `ALLOWED_EMAIL` | 唯一允许登录的完整邮箱 |

   本地配置应保留原文件的所有其他设置，特别是 `run_worker_first: true`、独立 assets 目录和 `preview_urls: false`。
   如果账户有多个 Cloudflare account，明确设置目标 `account_id`。
5. 仍使用示例资产运行 `npx wrangler deploy --config wrangler.local.json`。
   验证无痕窗口访问首页、`/demo-data.json`、`/data/awards-timeline.json` 均需登录或被拒绝；
   允许邮箱登录后能看到示例看板，其他邮箱不能访问。
6. 登录保护验证通过后才执行：

   ```bash
   npm run build:private
   npx wrangler deploy --config wrangler.local.json --dry-run --outdir .work/cloudflare/worker
   npx wrangler deploy --config wrangler.local.json
   ```

   此步骤会将真实 JSON 上传到自己的 Cloudflare 账户。上线后再次验证无痕窗口不能取得 JSON，
   本人登录能看到真实看板，筛选、累计时间点和气泡悬停正常。

## 保护机制与边界

- Access 在平台层覆盖这个 Worker 的所有域名与路由；不只保护首页。
- Worker 在每次资产请求前验证 Access JWT 的签名、签发方、应用 AUD、有效期、应用类型和邮箱；
  缺失配置返回 503，缺失或无效登录返回 403，不读取资产内容。
- 带 Static Assets 的 Worker 当前无法使用 `ctx.access`，因此使用官方推荐的 `jose` 验签方式。
- 页面资源由同一站点提供，CSP 限制脚本和数据连接到本站。所有应用响应均标记 `private, no-store`，禁止嵌入和搜索引擎收录。
- Worker 不记录访问正文或身份。无需数据库、存储桶或代码仓库同步真实数据。
- JWT 校验并非实时权限查询。撤权时应在 Access 撤销会话；紧急停用可清空 Worker 的 `ALLOWED_EMAIL` 后重新部署。
- `run_worker_first` 会消耗 Worker 请求额度；个人使用通常可从免费方案开始，具体配额以账户显示为准。

不要把登录票据或 API Token 写进代码、文档、终端命令参数或 Git。CLI 认证交由 Wrangler 自身管理。
`wrangler.local.json`、`.dev.vars*`、`node_modules/`、`.wrangler/` 以及全部构建产物都已忽略。

## 后续更新与回退

先本地确认 UI、校验数据，再重复第 6 步。`check:deploy` 会重建**示例**包，不能在它之后直接部署并期待真实数据。
回退 UI 时用 Cloudflare 的部署历史 Rollback；历史部署也可能包含旧的真实数据，应留在本人账户内并始终受 Access 保护。
真实数据删除后需要检查历史版本，不能仅删除本地文件。

Vercel 保留为备选：白名单资产可复用，但 Cloudflare Worker 的保护不会随静态文件迁移。
迁移前必须单独配置并验证 Vercel 的生产环境访问保护，然后才允许上传真实数据。

## 官方参考

- [Workers 的 Access 保护与限制](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)
- [Static Assets 先执行 Worker](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/)
- [Access JWT 验证示例](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
- [邮箱验证码登录](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/)
- [Workers 计费](https://developers.cloudflare.com/workers/platform/pricing/)
