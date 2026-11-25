# 部署到服务器

需要：一台 Linux 服务器（1 核 1G 内存够用）、一个域名、Docker 和 Docker Compose。

## 1. 准备

把域名的 A 记录（有 IPv6 的话再加 AAAA）指向服务器 IP。服务器防火墙只开 22、80、443 三个端口：

```bash
ufw default deny incoming
ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp && ufw allow 443/udp
ufw enable
```

注意：Docker 发布的端口会绕过 ufw。本项目只发布 80/443（Caddy），应用本身的 8787 端口不对外，所以没有影响。不要自己在 compose 里给 `app` 加 `ports:`。

## 2. 配置

```bash
git clone <你的仓库> lovememo && cd lovememo
cp deploy/.env.example deploy/.env
cp deploy/models.example.json deploy/models.json
openssl rand -base64 32        # 把输出填到 deploy/.env 的 DATA_KEY
nano deploy/.env               # 填 DOMAIN、DATA_KEY、各家 API Key
chmod 600 deploy/.env
```

`DATA_KEY` 用来加密所有人的数据。**它丢了，数据就再也解不开；它泄露了，拿到数据文件的人就能解开。** 请另外找个安全的地方（比如密码管理器）存一份，并且不要和数据备份放在一起。

`models.json` 决定大家能用哪些模型。Key 不写在这个文件里，而是写 `key_env`（环境变量名，必须以 `_API_KEY` 结尾），真正的 Key 放在 `deploy/.env`。`routes` 表示这个模型默认用于哪些任务：`recognize`（截图识别，需要 `supports_vision: true`）、`analyze`（复盘）、`quiz`（出题评分）、`roleplay`（角色扮演）。

## 3. 启动

```bash
docker compose -f deploy/docker-compose.yml up -d --build
docker compose -f deploy/docker-compose.yml logs app
```

日志里会有一段：

```
================ 首次安装 ================
打开 https://你的域名 ，用下面的安装码创建超级管理员：

    XXXXX-XXXXX-XXXXX-XXXXX-XXXXX
```

打开网址，填安装码、用户名、密码，就创建好了超级管理员。整个系统只有一个超级管理员，创建后安装码立即作废，之后只能凭注册码注册普通账号。

安装码只出现在服务器日志里，只有能登录服务器的人看得到，所以别人就算比你先打开网页也抢不走管理员。安装码每次重启都会换。

## 4. 给别人开账号

用管理员登录 → 左侧「管理」→「生成注册码」。可以设定能注册几个账号、多久过期。注册码只显示一次，请当面或私聊发给对方。用过的、过期的、撤销的码都不能再用。

## 5. 桌面版

桌面版第一次打开时填服务器地址（`https://你的域名`），然后用同一个账号登录，数据和网页版是同一份。登录凭证存在系统凭据管理器里。

## 6. 备份

数据都在 Docker 卷 `lovememo_app-data` 里（账号库 `server.sqlite` 和加密的用户数据 `userdata/`）。

```bash
# 每天备份一次（加进 crontab）
docker run --rm -v lovememo_app-data:/data -v /root/backup:/backup alpine \
  tar czf /backup/lovememo-$(date +%F).tgz -C /data .
```

恢复时把压缩包解回卷里，并且用**同一个** `DATA_KEY` 启动。

每个用户最近 3 个版本的数据都保留在 `userdata/<用户ID>/` 下，误操作时可以在服务器上手动删掉最新的那个 `.bin`、把 `server.sqlite` 里该用户的 `data_version` 改回上一个数字来回滚。

## 7. 更新

```bash
git pull
docker compose -f deploy/docker-compose.yml up -d --build
```

## 8. 忘记管理员密码

网页上没有"找回密码"，也没有任何能绕过密码的入口。只有能登录服务器的人可以重设超级管理员的密码：

```bash
docker compose -f deploy/docker-compose.yml exec -it app node server/src/cli.ts reset-admin-password
```

这个命令只能改超级管理员自己的密码，改完后管理员在所有设备上都会退出登录，并且会记进安全日志。普通用户忘了密码，只能由管理员删除账号后重新发注册码（数据会一起删除），因为管理员看不到、也改不了别人的密码。

## 安全设计说明

账号相关：密码用 scrypt（N=2^17）加盐哈希，至少 10 位并拒绝常见弱密码。同一 IP 对同一账号连续错 5 次锁 15 分钟，之后每次翻倍、最长 24 小时；同一账号从所有 IP 累计错 30 次整体锁 15 分钟；登录接口按 IP 每 15 分钟 20 次。锁定期间即使密码正确也拒绝。"用户不存在"和"密码错误"的提示、耗时都一样，猜不出哪些用户名存在。注册码和登录令牌都是服务端生成的随机数（125 位、256 位），库里只存 SHA-256。

会话：网页版用 `__Host-` 前缀的 HttpOnly + Secure + SameSite=Strict Cookie，页面脚本读不到；桌面版令牌存系统凭据，前端脚本同样拿不到。30 天到期、7 天不用自动失效。改密码会踢掉其他设备，停用账号立即踢下线。

请求：所有改数据的请求必须带自定义头并且来源是本站（防跨站请求伪造），不响应任何 CORS；Host 头必须是配置的域名（防 DNS 重绑定和用 IP 直连）；有严格的 CSP、HSTS、禁止被嵌入 iframe；请求体有大小上限；所有数据库查询都是参数化的；静态文件拒绝路径穿越。

数据：每个人的数据用 AES-256-GCM 加密后存盘，密文绑定了用户 ID 和版本号，挪到别人名下也解不开。服务端从不执行用户上传的 SQL，只存取加密后的字节。管理员没有任何接口能读别人的数据。

AI：Key 只在服务器上，前端只能按 id 选管理员配置好的模型，不能指定地址（防止被拿来访问内网）；转发时只保留认识的字段，图片只接受内嵌数据，不跟随重定向；每人每天、每分钟的调用次数有上限。

没有后门：代码里没有万能密码、调试开关、"以某用户身份登录"、管理员读数据或改别人密码的接口。服务端只用 Node 内置模块，没有第三方运行时依赖。`server/test/` 里的测试覆盖了上面这些攻击场景，可以用 `npm run test:server` 自己跑一遍。

## 需要你自己注意的

服务器本身的安全不在这个项目的范围内，但很关键：SSH 只用密钥登录、关掉密码登录；系统和 Docker 定期更新；`deploy/.env` 权限 600，不要提交到 git。能登录服务器的人拥有一切权限（包括 `DATA_KEY`），所以服务器的登录权限就是最后一道门。
