# 把 ReadFlow 部署到阿里云轻量应用服务器

> **适用机器**：2 vCPU / 1 GiB 内存 / 30 GiB 系统盘 / 200 Mbps 峰值带宽 / 1 个固定 IPv4，Ubuntu 22.04 或 24.04
> **文档日期**：2026-11-10
> **状态**：配套脚本已通过本地语法检查，但**尚未在真实服务器上完整跑通**。第一次部署请按第 7 节的排查表看报错，别慌。

---

## 0. 先看清这套部署在做什么

```
你的 Mac                          阿里云服务器
─────────────                    ─────────────────────────────
npm run build  ── .next 产物 ──▶  /opt/readflow/releases/<版本>/
（下载 Google Fonts）              /opt/readflow/current → 软链接到当前版本
                                   /var/lib/readflow/data/  ← 数据库、词典、图片缓存
data/dict/ecdict.db ── 94MB ──▶    （升级、回滚都不动这个目录）
data/readflow.db ── 在线快照 ──▶
                                   systemd 跑 next start -p 3000 -H 127.0.0.1
                                   nginx :80 → 127.0.0.1:3000
                                   cron 每天 03:30 备份数据库
```

**关键分工：构建在 Mac，运行只在服务器。** 原因见下一节。你的浏览器只碰 nginx 的 80 端口，Node 不直接暴露在公网。

---

## 1. 为什么不用默认的 `deploy.sh release`

`deploy/` 里原本已有一整套部署工具（systemd、nginx、软链接发布、失败自动回滚、每日在线备份、国内 npm 镜像），质量是够的。但按你买的这台机器，直接跑默认发布流程会撞上三件事：

| 阻塞 | 原因 | 本文档怎么绕开 |
|---|---|---|
| **`deploy/` 未提交** | `deploy.sh release` 用 `git archive HEAD` 打包，只含已提交文件；服务器要执行的 `remote-release.sh` 就在这个目录里，包里没有它就会失败 | `release-local.sh` 用 rsync 直接传目录，不走 `git archive`。第 3 节 Step 0 仍建议提交，方便以后用默认流程 |
| **1 GiB 内存** | 原脚本按「2核2G」设计，服务器端跑 `npm run build` 且设了 `--max-old-space-size=1536`。1G 物理内存 + 2G swap 跑 Next 16 构建，大概率极慢或 OOM | Mac 上构建好，服务器只 `npm ci --omit=dev` + `next start` |
| **Google Fonts** | `layout.tsx` 用 `next/font/google`，**构建时**要从 Google 下载字体（产物是 `.next/static/media/*.woff2`）。国内服务器基本连不上，构建会卡住 | 构建发生在你的 Mac 上；字体已经打包进 `.next`，运行时是本地自托管，服务器全程不需要外网 |

> 运行时不需要 Google Fonts，只有构建那一刻需要。这是「本机构建」能一次解决两个问题的原因。

另外两个要留意的小问题：

- `server-setup.sh` 写死了 `NODE_VERSION=24.14.1`，而你的 Mac 是 `v22.22.2`。Step 2 给了预检和补救命令。
- `npm ci --omit=dev` 是**必须的**：`devDependencies` 里的 `playwright` 会在安装时下载浏览器，国内服务器上又慢又容易失败，而运行时根本用不到。

---

## 2. 部署前准备

### 阿里云控制台

1. 记下**公网 IP** 和 root 密码（或绑定 SSH 密钥）。
2. 「防火墙 / 安全组」放行 TCP **22、80、443**。轻量应用服务器在实例详情页的「防火墙」标签里加规则。
3. **关掉自动续费**，并在日历里设一个到期前 30 天的提醒——这是你这次选最便宜档之后最重要的一条纪律。
4. 备案下来之前 `DOMAIN` 留空，用 `http://公网IP` 访问。国内节点绑域名走 80/443 需要 ICP 备案，流程通常十几个工作日，别在这一步卡住。

### 你的 Mac

项目根目录执行，确认工具齐备（已验证过）：

```bash
cd /Users/siyuancheng/Projects/readflow
command -v node npm sqlite3 rsync ssh tar
```

### 当前仓库状态（重要）

```
HEAD      981ce92（P21 安全修复/手机号登录 + P22 选词对齐），尚未 push
未提交    .gitignore、README.md
未跟踪    deploy/ 整个目录
```

如果这是另一路会话在改同一批文件，**先确认不会互相覆盖**再往下走。本文档的路径不要求先提交，但第 0 步建议做。

---

## 3. 操作步骤

### Step 0 · 把部署工具纳入版本控制（推荐，非阻塞）

```bash
cd /Users/siyuancheng/Projects/readflow
git add deploy/ .gitignore README.md
git commit -m "deploy: 阿里云轻量服务器部署工具 + 本机预构建发布路径"
git push origin main
```

验收（这一步决定以后能不能用默认的 `deploy.sh release`）：

```bash
git archive HEAD | tar -tz | grep deploy/remote-release.sh
```

`git push` 若报 `SSL_ERROR_SYSCALL`（本机代理常见），用：

```bash
GIT_HTTP_LOW_SPEED_LIMIT=0 GIT_HTTP_LOW_SPEED_TIME=999 \
git -c http.version=HTTP/1.1 -c http.postBuffer=524288000 push origin main
```

> 不做这一步也能用本文档部署（`release-local.sh` 自己 rsync 整个 `deploy/` 到服务器）。但做了之后，`deploy.sh status / logs / backup / rollback` 这些日常命令才和服务器上的脚本版本一致。

### Step 1 · 填配置

```bash
cp deploy/deploy.conf.example deploy/deploy.conf
```

编辑 `deploy/deploy.conf`（这个文件已被 `.gitignore` 忽略，不会进仓库）：

```bash
SERVER=root@你的公网IP
SSH_PORT=22
SSH_KEY=
DOMAIN=
```

用密钥登录就把 `SSH_KEY` 填成私钥路径。嫌密码登录反复输入，先配免密：

```bash
ssh-copy-id root@你的公网IP
```

### Step 2 · 初始化服务器

先预检脚本里写死的 Node 版本能不能从国内镜像下到：

```bash
curl -I --max-time 10 \
  https://registry.npmmirror.com/-/binary/node/v24.14.1/node-v24.14.1-linux-x64.tar.xz | head -1
```

返回 `200` 就继续：

```bash
bash deploy/deploy.sh setup
```

这一步约 3–5 分钟，会装 Node / nginx / sqlite3 / 编译工具、加 2G 交换空间、建 `readflow` 用户与目录、装 systemd 服务与 nginx 反代、配每天 03:30 的备份。

**如果卡在 Node 下载**（返回 404 / 超时），`deploy/` 目录此时已经传到服务器了，直接指定与本机一致的版本重跑：

```bash
ssh root@你的公网IP 'NODE_VERSION=22.22.2 bash /root/readflow-deploy/server-setup.sh'
```

### Step 3 · 上传词典和数据库

```bash
bash deploy/deploy.sh init-data
```

会传 94MB 的 `ecdict.db`，再用 `sqlite3 .backup` 做一份**在线快照**把本机 `data/readflow.db` 传上去（本机服务开着也安全，账号、文章、词库会原样搬过去）。服务器上已有数据库时**不会覆盖**。

> **试用机别放真实数据。** 如果你只想演练，先只传词典、用空库起步：
>
> ```bash
> rsync -az --progress -e "ssh -p 22" data/dict/ecdict.db \
>   root@你的公网IP:/var/lib/readflow/data/dict/ecdict.db
> ssh root@你的公网IP 'chown -R readflow:readflow /var/lib/readflow/data'
> ```
>
> 这样首次打开网站会走 `/setup` 建一个新账号，和你本机的数据完全隔离。

### Step 4 · 发布

```bash
bash deploy/release-local.sh
```

它依次做：本机构建（用数据库快照，不抢锁）→ 打包 `.next`（排除 76MB 构建缓存）+ `package.json` + lock + `next.config.ts` + `public` + `src` → 上传 → 服务器 `npm ci --omit=dev` → 建 `data` 软链接 → 切 `current` 软链接 → 重启 → 60 秒健康检查 → 失败自动回滚。

首次约 3–8 分钟（大部分是服务器 `npm ci` 编译 `better-sqlite3`）；之后依赖没变会复用 `node_modules`，快很多。

### Step 5 · 验收

逐条打勾：

- [ ] `bash deploy/deploy.sh status` → `active (running)`，能看到当前版本号
- [ ] `curl http://你的公网IP/api/auth/status` → `{"needsSetup":true}` 或 `false`（200）
- [ ] 浏览器打开 `http://你的公网IP` → 出现 `/setup` 或登录页（不是 502 / 连接超时）
- [ ] 登录后导入一篇英文文章，点一个词能查到词典释义（说明 94MB 词典路径正确）
- [ ] `bash deploy/deploy.sh backup` → Mac 的 `backups/` 下出现 `readflow-*.db.gz`
- [ ] 服务器上看一眼备份日志：`ssh root@IP 'tail -5 /var/lib/readflow/backups/backup.log'`

---

## 4. 日常运维

| 想做什么 | 命令 |
|---|---|
| 改完代码发新版 | `bash deploy/release-local.sh`（本地改动即可，不要求先提交） |
| 看服务状态 / 当前版本 / 最近备份 | `bash deploy/deploy.sh status` |
| 跟踪日志 | `bash deploy/deploy.sh logs`（Ctrl+C 退出） |
| 立刻备份并下载到 Mac | `bash deploy/deploy.sh backup` |
| 新版本有问题，回退 | `bash deploy/deploy.sh rollback` |
| 重启服务 | `ssh root@IP 'systemctl restart readflow'` |
| 加账号 | `ssh root@IP 'cd /opt/readflow/current && sudo -u readflow DB_PATH=/var/lib/readflow/data/readflow.db npm run add-user -- 用户名 --phone=手机号'` |

> 加账号也可以在你 Mac 上用 `npm run add-user` / `list-users` / `reset-password`，但那是操作**本机**数据库；服务器上要用上面那条带 `DB_PATH` 的命令。

---

## 5. 备案通过后：绑域名 + HTTPS

1. 域名解析加一条 A 记录指向服务器公网 IP。
2. `deploy/deploy.conf` 里填 `DOMAIN=你的域名`，重新跑一次 `bash deploy/deploy.sh setup`（只更新 nginx 配置，**不动数据**）。
3. 申请免费证书：

```bash
ssh root@你的公网IP
apt-get install -y certbot python3-certbot-nginx
certbot --nginx -d 你的域名
```

之后访问 `https://你的域名`。nginx 已经设了 `proxy_set_header X-Forwarded-Proto $scheme`，登录 cookie 会自动带上 `Secure`；`TRUST_PROXY=1` 也在 `/etc/readflow/readflow.env` 里配好了，登录限速按真实访客 IP 计数，客户端伪造 `X-Forwarded-For` 无效。

---

## 6. 到期 / 涨价：怎么搬家

这正是你选最便宜档之后真正的保险。你的全部资产就是**一个 `readflow.db` 文件 + 这份代码**：

1. 在老服务器上 `bash deploy/deploy.sh backup`，把 `.db.gz` 拉回 Mac 的 `backups/`。
2. 新服务器（腾讯/阿里/任意 Ubuntu）买好后，把 `deploy/deploy.conf` 的 `SERVER` 换成新 IP。
3. 重复 Step 2 → Step 3（把备份解压成 `readflow.db` 放到 `/var/lib/readflow/data/`）→ Step 4。
4. 掐表看从零恢复到能登录要多久。二十分钟内跑通，续费涨不涨价就跟你没关系了。

> 注意：备案是唯一会增加迁移摩擦的东西（换厂商要重新接入）。第一年用 IP 访问、别急着绑域名，就是为了保留这个自由度。

---

## 7. 故障排查

| 现象 | 先查什么 |
|---|---|
| `setup` 卡在 Node 下载 | 用 Step 2 的 `NODE_VERSION=22.22.2` 补救命令重跑 |
| `release-local.sh` 报「缺少 /etc/readflow/readflow.env」 | `setup` 没跑成功，先重跑 Step 2 |
| 浏览器 502 | `bash deploy/deploy.sh logs`；多半是 `next start` 没起来，或 3000 端口被占 |
| 能打开页面但点词报「词典库不存在」 | `ssh root@IP 'ls -l /var/lib/readflow/data/dict/'`；确认 94MB 的 `ecdict.db` 在，且 `current/data` 软链接指向 `/var/lib/readflow/data` |
| 构建报字体下载失败 | 构建是在 Mac 上跑的；如果 Mac 也失败，说明本机代理拦了 Google Fonts，先把代理调通 |
| `npm ci` 很慢 / 卡住 | 首次现场编译 `better-sqlite3` 正常，等几分钟；确认 `/home/readflow/.npmrc` 的国内镜像在 |
| 日志报找不到 `@tailwindcss/turbopack` | `npm ci --omit=dev` 没装 devDependencies，但 `next.config.ts` 里引用了它。把 `remote-prebuilt.sh` 的安装命令改成 `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci`（全量装但跳过浏览器下载）再发布一次 |
| 健康检查 60 秒超时、自动回滚 | `journalctl -u readflow -n 100` 看真实报错；常见是 `DB_PATH` 指向的文件权限不对（`chown readflow:readflow`） |
| 浏览器打开直接 403 / 被拦 | 未备案域名走 80 会被拦；先确认是用**公网 IP** 访问，`DOMAIN` 留空 |
| 页面能开但 AI 释义不出字 | 境外模型 API（OpenAI / Claude）在国内服务器可能不通，设置里换 DeepSeek 或通义千问 |

---

## 8. 安全与费用提醒

- **别长期用明文 HTTP 传登录态**：账户体系的 session cookie 会被截获。备案下来立刻切 HTTPS；在此之前只放测试数据、别用真实密码。
- 模型 Key、墨墨 Token 都存在数据库 `settings` 表的站级行里，跟着 `readflow.db` 走；**备份文件等于密钥**，别传到公开地方。
- `/etc/readflow/readflow.env` 权限是 `640`，也可把 `DEEPSEEK_API_KEY` / `MARKJI_TOKEN` 写在这里兜底，改完 `systemctl restart readflow`。
- `/api/img` 代理的外链图片在国内服务器可能超时，有 `img-cache` 兜底，属可接受的降级。
- 登录限速是进程内计数器，重启清零；这条限制已在 `docs/ARCHITECTURE.md` 记录。
- **关自动续费 + 到期提醒**。到期实例会被释放，快照和数据一起没——所以第 5 节的每日备份不是可选项。
