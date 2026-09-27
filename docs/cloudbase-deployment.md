# CloudBase 免费体验部署

目标：在无需自有域名的 CloudBase 免费体验环境中试运行私有看板，保留现有界面和功能。

## 部署设计

整个页面通过一个普通事件云函数提供。HTML、JS、D3、JSON 都放在函数包内部，逐次通过服务端身份验证后才能返回，
不另建可公开读取 JSON 的静态托管副本。HTTP 网关使用环境默认域名的 `/vesting/` 入口。

使用浏览器内置的 HTTP Basic 登录：用户名 `vesting`，配合随机生成的个人访问口令。
口令仅保存在本机忽略目录，服务端环境变量保存其 SHA-256 摘要。公网只允许通过 HTTPS 使用。
所有应用响应设置 `private, no-store`，无效或缺失认证不返回资产，配置缺失默认拒绝。

## 环境和验收要求

- 在本人账户开通免费体验环境，确认套餐、到期时间、自动续费与超额付费状态。
- 完成 CLI 授权；控制台会说明此授权允许本机 CloudBase CLI 操作云资源，包括 COS、SCF 和数据库。
- 先运行测试并部署示例，核对认证、JSON 直链、缓存行为和浏览器交互，再发布真实数据。
- 如使用过临时示例口令，必须在上传真实数据前撤销，并确认旧口令已无法读取资产。
- 发布后确认授权下载的真实 JSON 与本地原文件 SHA-256 一致，匿名和错误口令无法取得任何资产。

访问地址及专用口令可保存在本机忽略文件 `data/cloudbase-access.local.json`（0600）；部署结果和验证记录放在 `.work/cloudbase/`。
平台默认域名和协议头行为需要在目标环境实测，本地测试不能代替线上验收。
不自动升级套餐，不开启按量付费，不将私人数据或访问口令提交至 Git。

## 本地命令

```bash
nvm use
npm ci
npm test
npm run cb:build:demo
npm run cb:login
npm run cb:envs
```

`cb:login` 使用腾讯云官方设备授权流程，不需要将 SecretKey 粘贴进聊天。
免费环境须按控制台的免费体验入口领取/兑换开通；不要直接使用 CLI 的付费套餐创建命令。
建议选择上海地域，与配置示例保持一致。

构建包位于 `.work/cloudbase/functions/vesting/`，只有入口 JS、无依赖的 package.json 及允许发布的资产。
`.work/cloudbase/manifest.json` 记录文件 SHA-256，清单自身不上传。
原始数据、临时日志、截图和本机配置不会被复制进函数包。

## 账户就绪后

1. 核对环境确为免费体验版，再复制 `cloudbaserc.example.json` 为根目录 `cloudbaserc.local.json`（已忽略）。
   填入真实环境 ID；保持 3 秒、256 MB、Nodejs20.19、`index.main` 和关闭云端依赖安装。
2. 在本机生成至少 24 字节密码学随机访问口令，保存到忽略的 `data/` 目录、文件权限设为 0600；
   将口令 SHA-256 的十六进制摘要填入本机配置的 `DASHBOARD_PASSWORD_SHA256`，不要存明文到环境变量或代码。
3. `npm run cb:build:demo`，再部署示例函数：

   ```bash
   npx tcb fn deploy vesting --config-file cloudbaserc.local.json --runtime Nodejs20.19 --install-dependency false
   ```

4. 使用默认域名的 HTTP 网关为事件函数添加 `/vesting` 前缀路由。
   兼容 CLI 入口为 `npx tcb service create -e <环境ID> -r ap-shanghai -f vesting -p /vesting`。
   确认启用**完整路径透传**（`EnablePathTransmission=true`），使函数收到 `/vesting/...` 原始路径；
   平台身份认证 `EnableAuth=false`，访问控制由函数内部对每个资源执行。
   CLI 3.8.4 的 `routes edit` 支持编辑已存在的路由。旧 `service create` 会将路由创建在 `*` 域名组，
   不在实际默认域名的专用路由组。先读取全部路由，核对 `/vesting` 的上游为 `SCF`、函数名为 `vesting`，
   确认所属域名组后再更新并重复读取确认：

   ```bash
   npx tcb routes list -e <环境ID> -r ap-shanghai --limit 1000 --json
   npx tcb routes edit -e <环境ID> -r ap-shanghai --data '{"domain":"*","routes":[{"path":"/vesting","enableAuth":false,"enablePathTransmission":true}]}' --yes --json
   ```

   旧 `service list` 不展示这两个布尔开关，不能用于验收它们。不要因此购买域名或切换付费套餐。
5. 浏览器使用 `https://<实际默认域名>/vesting/`，不要把用户名和口令拼进 URL。
   默认域名可能先显示平台“确认访问”中间页，确认后再检查浏览器的用户名/密码登录提示。
   验证允许的口令能打开看板，未登录/错误口令不能获取任何资产；授权读取 JSON 后，匿名再次读取仍应被拒绝。
   必须验证平台实际保留 `Authorization`、`WWW-Authenticate` 和禁止缓存响应头，JS/JSON 子请求正常。
   同时确认公网 HTTP 入口被平台拒绝或跳转到 HTTPS，并确认平台注入的协议头可信；
   代码只拒绝明确标记为 HTTP 的请求，不能仅凭本地测试声称平台已强制 HTTPS。
6. 只有线上示例验收通过后，发布真实数据并再次进行私有数据访问校验：

   ```bash
   npm run cb:build:private
   npx tcb fn deploy vesting --config-file cloudbaserc.local.json --runtime Nodejs20.19 --install-dependency false --force
   ```

   `--force` 更新前面已经创建的同名函数；运行前确认本机配置中的环境 ID 为自己的目标环境。

当前默认域名仅适合个人开发测试：新建环境不再要求频繁续域名，但有平台访问提示和频率等限制；
官方生产浏览器访问方案要求自定义域名。免费环境本身的六个月手动续期规则是另一项限制。
验收时应确认：匿名及错误口令返回 401，正确口令返回完整资产，认证后匿名重取不能命中私人缓存；HTTP 应返回 426 且无登录挑战，或由平台跳转到 HTTPS。
还应确认客户端伪造 `X-Forwarded-Proto` 不能改变协议判断；代码依赖网关注入可信协议头，平台行为须实测。
默认域名会先显示腾讯云“确认访问”页。部分内置浏览器可能无法显示原生 Basic 登录弹窗，
日常访问可在支持原生 HTTP 登录的 Chrome / Safari 中使用普通 HTTPS 地址。

修改口令摘要并重新部署可撤销旧口令。Cloudflare 配置继续保留，切换平台时不共享登录凭证。

## 官方参考

- [普通事件云函数与集成响应](https://docs.cloudbase.net/cloud-function/how-coding)
- [HTTP 网关访问云函数](https://docs.cloudbase.net/service/access-cloud-function)
- [HTTP 网关与默认域名](https://docs.cloudbase.net/service/introduce)
- [默认域名访问提示与限制](https://docs.cloudbase.net/service/alias)
- [免费环境及资源点](https://cloud.tencent.com/document/product/876/127357)
