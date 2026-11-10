# 部署到云服务器

把 ReadFlow 部署到一台 Linux 云服务器（例如阿里云 99 元/年的 2核2G）。
所有命令都在**你的 Mac、项目根目录**运行，脚本会通过 ssh 去操作服务器。

> 状态：脚本已写好，在模拟服务器（Ubuntu 24.04 容器）上跑通了「初始化服务器」和「上传数据」两步；
> 「发布」这一步还没完整跑通过，第一次真正部署时按实际报错再调整。

## 文件

| 文件 | 作用 | 在哪运行 |
|---|---|---|
| `deploy.sh` | 一键入口：初始化 / 上传数据 / 发布 / 状态 / 日志 / 回滚 / 备份 | Mac |
| `deploy.conf.example` | 配置模板，复制为 `deploy.conf`（不进 git） | — |
| `server-setup.sh` | 初始化服务器：Node、Nginx、交换空间、用户与目录、服务、备份 | 服务器（由 `deploy.sh setup` 调用） |
| `remote-release.sh` | 发布：装依赖 → 构建 → 切换版本 → 重启 → 健康检查，失败自动回滚 | 服务器（由 `deploy.sh` 调用） |
| `readflow.service` | systemd 服务：开机自启、崩溃自动重启 | 服务器 |
| `nginx.conf.template` | Nginx 反代：80 端口 → 本机 3000，关掉缓冲让 AI 释义流式输出 | 服务器 |
| `backup.sh` | 每天 03:30 备份数据库，校验后压缩，保留 14 份 | 服务器（cron） |

## 服务器上的目录

```
/opt/readflow/releases/<时间-提交号>/   每次发布一份代码（只保留最近 3 份）
/opt/readflow/current                  → 当前运行的版本（软链接）
/var/lib/readflow/data/                数据库、词典、图片缓存（升级、回滚都不动它）
/var/lib/readflow/backups/             每日备份
/etc/readflow/readflow.env             环境变量（DB_PATH、TRUST_PROXY=1 等）
```

## 第一次部署

### 0. 买服务器时
- 镜像选 **Ubuntu 22.04 或 24.04**（脚本目前只支持 Ubuntu）。
- 在控制台「安全组 / 防火墙」放行 **22、80、443** 端口。
- 记下公网 IP 和 root 密码（或者绑定 SSH 密钥）。

### 1. 填配置
```bash
cp deploy/deploy.conf.example deploy/deploy.conf
```
打开 `deploy/deploy.conf`，把 `SERVER=root@1.2.3.4` 改成你的公网 IP；用密钥登录就填 `SSH_KEY`。
备案下来之前 `DOMAIN` 留空。

### 2. 初始化服务器（约 3–5 分钟）
```bash
bash deploy/deploy.sh setup
```
第一次连接会问是否信任服务器指纹，输入 `yes`；用密码登录的话中途会多次要求输入密码，
嫌麻烦可以先执行 `ssh-copy-id root@你的IP` 配好免密登录。

### 3. 上传词典和数据库
```bash
bash deploy/deploy.sh init-data
```
- 上传 94MB 的 ECDICT 词典。
- 上传本机数据库的**在线快照**（本机服务开着也安全），你的账号、文章、词库会原样搬过去。
- 服务器上已经有数据库时**不会覆盖**。

### 4. 发布（首次约 5–10 分钟，之后依赖不变会快很多）
```bash
bash deploy/deploy.sh
```
发布的是 git 里**已提交**的代码；有未提交的改动时会提醒，但不会带上去。
完成后浏览器打开 `http://你的公网IP` 即可访问。

## 日常

```bash
bash deploy/deploy.sh            # 改完代码、提交后发布新版本
bash deploy/deploy.sh status     # 服务状态、当前版本、最近一次备份
bash deploy/deploy.sh logs       # 跟踪日志（Ctrl+C 退出）
bash deploy/deploy.sh rollback   # 新版本有问题：回到上一个版本
bash deploy/deploy.sh backup     # 立刻备份一次，并下载到本机 backups/（建议定期做，异地留一份）
```

加用户（在服务器上）：
```bash
ssh root@你的IP
cd /opt/readflow/current && sudo -u readflow DB_PATH=/var/lib/readflow/data/readflow.db npm run add-user -- 用户名 --phone=手机号
```

## 备案通过后：绑域名 + HTTPS

1. 域名解析：添加 A 记录指向服务器公网 IP。
2. `deploy/deploy.conf` 里填 `DOMAIN=你的域名`，重新执行 `bash deploy/deploy.sh setup`（会更新 Nginx 配置，不动数据）。
3. 申请免费证书（Let's Encrypt，自动续期）：
   ```bash
   ssh root@你的IP
   apt-get install -y certbot python3-certbot-nginx
   certbot --nginx -d 你的域名
   ```
   之后访问 `https://你的域名`，登录 cookie 会自动带上 Secure。

## 已知要注意的点

- **构建内存**：2G 内存跑 `next build` 比较紧，初始化时会自动加 2G 交换空间；构建慢一点是正常的。
- **构建用数据库快照**：发布时先把线上库快照一份给构建用，构建不会和运行中的服务抢锁。
- **data/ 软链接在构建之后才建**：Turbopack 不允许项目里有指向项目外的软链接，构建前建会直接失败（模拟测试里遇到过）。
- **国内网络**：Node 和 npm 包都走 npmmirror 国内镜像；`better-sqlite3` 的预编译包也走镜像，拿不到时用已安装的编译工具现场编译。
- **AI 费用**：模型 Key 全站共用，所有用户的 AI 释义都消耗你的额度。
- **登录限速**：`TRUST_PROXY=1` 已配好，Nginx 会把 `X-Forwarded-For` 改写成真实访客 IP，客户端伪造无效。
