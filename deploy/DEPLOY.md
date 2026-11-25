# 部署到服务器

需要：一台 Linux 服务器（1 核 1G 内存够用）、Docker 和 Docker Compose。用 https 访问还需要一个域名。

## 0. 先选访问方式：https 还是 http

在 `deploy/.env` 里用 `COMPOSE_PROFILES` 选，只能二选一：

| | https（推荐） | http |
|---|---|---|
| 传输 | 加密 | **不加密，明文** |
| 证书 | Caddy 自动申请免费证书并续期，不用自己买 | 不需要 |
| 需要 | 域名，80 和 443 端口能从公网访问 | 80 端口 |
| 适合 | 公网长期使用 | 内网、局域网、临时测试 |

**http 模式的风险，请先看清楚再选：** 登录密码、登录凭证、所有聊天记录和复盘内容、管理员在网页上填的 API Key，在网络上都是明文传输。和你连同一个 Wi-Fi 的人、运营商、路上经过的任何一台设备都能看到，也能偷偷改掉网页内容。服务器启动日志会打印这条提醒，网页登录页和桌面版也会提示。用 http 时请至少做到：密码不要和其他网站重复；不在公共 Wi-Fi 下登录；API Key 设置消费上限，能的话在内网或通过 VPN 访问。

**关于备案（服务器在中国大陆时）：** 是否需要备案取决于服务器在哪里，和用不用证书、用 http 还是 https 无关。中国大陆的云服务器（阿里云、腾讯云等）用域名访问网站时，云厂商会按域名检查备案，没备案的域名 http 和 https 都会被拦截（http 返回一个"未备案"提示页，https 直接断开）。证书解决的是加密问题，解决不了备案问题。所以：

1. 服务器在中国大陆：先给域名备案，备案通过后用 https 模式。
2. 不想备案：换一台中国香港或海外的服务器，用 https 模式。
3. http 模式适合内网或局域网里的服务器（比如家里或公司内网的机器），这种情况不经过云厂商的拦截。

## 1. 准备

**https 模式：**

1. 域名解析：在域名服务商那里给你要用的域名加 A 记录（有 IPv6 的话再加 AAAA），指向服务器公网 IP。`DOMAIN` 填的是哪个就解析哪个：填 `example.com` 要解析 `@`，填 `memo.example.com` 要解析 `memo`。`www` 和不带 `www` 是两个不同的地址，各自要有记录。
2. 确认解析生效：在自己电脑上 `ping 你的域名`，显示的 IP 要是服务器的 IP。
3. 云服务器的安全组（控制台里的防火墙）放行 TCP 80、TCP 443、UDP 443。Caddy 申请证书时，证书机构会从公网访问 80 或 443 端口来验证域名是你的，所以 80 也必须开着。
4. 确认 80 和 443 没被别的程序占用：`ss -ltnp | grep -E ':(80|443) '`，有输出就说明被占了（常见的是服务器自带的 Nginx、宝塔面板），先停掉它，或者改用它来转发（见文末「已经有 Nginx 的服务器」）。
5. 已经买了证书的话不用管它，Caddy 会自动申请免费证书（Let's Encrypt / ZeroSSL），每 60 天左右自动续期，不需要上传证书文件。

**http 模式：** 只需要 80 端口能访问、没被占用（检查方法同上）。`DOMAIN` 填访问时地址栏里的域名或 IP。

服务器防火墙只开需要的端口（http 模式不用开 443）：

```bash
ufw default deny incoming
ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp && ufw allow 443/udp
ufw enable
```

注意：Docker 发布的端口会绕过 ufw。本项目只发布 Caddy 的 80（和 443），应用本身的 8787 端口不对外，所以没有影响。不要自己在 compose 里给 `app` 加 `ports:`。

## 2. 配置

```bash
git clone <你的仓库> lovememo && cd lovememo
cp deploy/.env.example deploy/.env
openssl rand -base64 32        # 把输出填到 deploy/.env 的 DATA_KEY
nano deploy/.env               # 选 COMPOSE_PROFILES（https 或 http），填 DOMAIN 和 DATA_KEY
chmod 600 deploy/.env
```

`DATA_KEY` 用来加密所有人的数据，以及你在网页上填的各家 API Key。**它丢了，数据就再也解不开；它泄露了，拿到数据文件的人就能解开。** 请另外找个安全的地方（比如密码管理器）存一份，并且不要和数据备份放在一起。

AI 的端点地址和 API Key 不写在配置文件里，启动后在网页上添加（见第 4 步）。

## 3. 启动

```bash
docker compose -f deploy/docker-compose.yml up -d --build
docker compose -f deploy/docker-compose.yml logs app
```

`up` 会按 `COMPOSE_PROFILES` 只启动对应的那个 Caddy（`caddy` 或 `caddy-http`）。

https 模式第一次启动时，Caddy 要花几秒到一两分钟申请证书，可以看它的日志：

```bash
docker compose -f deploy/docker-compose.yml logs -f caddy
```

看到 `certificate obtained successfully` 就好了。如果一直报错，最常见的原因是：域名还没解析到这台服务器、安全组没开 80/443、80/443 被别的程序占着、服务器在中国大陆而域名没备案。同一个域名短时间内失败太多次，证书机构会暂时限制申请，修好问题后等一会儿再试。

应用的日志里会有一段：

```
================ 首次安装 ================
打开 https://你的域名 ，用下面的安装码创建超级管理员：

    XXXXX-XXXXX-XXXXX-XXXXX-XXXXX
```

打开网址，填安装码、用户名、密码，就创建好了超级管理员。整个系统只有一个超级管理员，创建后安装码立即作废，之后只能凭注册码注册普通账号。

安装码只出现在服务器日志里，只有能登录服务器的人看得到，所以别人就算比你先打开网页也抢不走管理员。安装码每次重启都会换。

## 4. 开启 AI 模型

用管理员登录 → 左侧「管理」→「AI 模型」→「添加服务商」：

1. 选一个常用服务商（会自动填好端点地址），或者选「自定义」自己填端点地址，再填 API Key。
2. 点「获取模型列表」，服务器会用这个 Key 去问服务商有哪些模型。如果服务商不提供模型列表，可以手动填写模型名。
3. 勾选要开放给大家的模型，输入你的登录密码，点「保存并开启」。

添加后，每个模型可以单独开关，可以标注它适合哪些任务（截图识别、复盘、出题、角色扮演），大家在「设置 → 模型」里默认会用你标注的那个。截图识别需要勾选「支持图片」。整个服务商也可以一键关掉。

API Key 用 `DATA_KEY` 派生的密钥加密后存进数据库，网页上只显示尾号，任何接口都拿不回明文。修改端点地址或 Key 时要再输一次登录密码；改了端点地址必须重新填 Key，旧 Key 不会被发到新地址。

服务器默认不允许端点地址指向内网或本机（包括 `localhost`、`192.168.x.x`、云服务器的元数据地址），防止有人借服务器去访问你内网里的东西。如果你确实要用自己部署在内网的模型（比如 Ollama），在 `deploy/.env` 里加 `ALLOW_PRIVATE_LLM_HOSTS=1` 再重启。

## 5. 给别人开账号

用管理员登录 → 左侧「管理」→「生成注册码」。可以设定能注册几个账号、多久过期。注册码只显示一次，请当面或私聊发给对方。用过的、过期的、撤销的码都不能再用。

## 6. 桌面版

桌面版第一次打开时填服务器地址（`https://你的域名`；http 模式填 `http://你的域名或IP`，桌面版会提示连接不加密，勾选确认后才能连接），然后用同一个账号登录，数据和网页版是同一份。登录凭证存在系统凭据管理器里。

## 7. 备份

数据都在 Docker 卷 `lovememo_app-data` 里（账号库 `server.sqlite` 和加密的用户数据 `userdata/`）。

```bash
# 每天备份一次（加进 crontab）
docker run --rm -v lovememo_app-data:/data -v /root/backup:/backup alpine \
  tar czf /backup/lovememo-$(date +%F).tgz -C /data .
```

恢复时把压缩包解回卷里，并且用**同一个** `DATA_KEY` 启动。

每个用户最近 3 个版本的数据都保留在 `userdata/<用户ID>/` 下，误操作时可以在服务器上手动删掉最新的那个 `.bin`、把 `server.sqlite` 里该用户的 `data_version` 改回上一个数字来回滚。

## 8. 更新

```bash
git pull
docker compose -f deploy/docker-compose.yml up -d --build
```

## 9. 切换访问方式

改 `deploy/.env` 里的 `COMPOSE_PROFILES` 之后，要先把旧的全部停掉再启动，否则旧的 Caddy 还占着端口：

```bash
docker compose -f deploy/docker-compose.yml --profile https --profile http down   # 不要加 -v，加了会删数据
docker compose -f deploy/docker-compose.yml up -d
```

数据、账号都不受影响。切换后所有人都要重新登录一次（http 和 https 用的登录凭证不通用），桌面版要在登录页点「更换」改一下服务器地址。

从 https 换回 http 时注意：浏览器访问过 https 版之后会记住"这个域名只用 https"（一年），之后再用 http 打开会被浏览器自动改成 https。所以同一个域名最好定下来就不要来回换。

## 10. 忘记管理员密码

网页上没有"找回密码"，也没有任何能绕过密码的入口。只有能登录服务器的人可以重设超级管理员的密码：

```bash
docker compose -f deploy/docker-compose.yml exec -it app node server/src/cli.ts reset-admin-password
```

这个命令只能改超级管理员自己的密码，改完后管理员在所有设备上都会退出登录，并且会记进安全日志。普通用户忘了密码，只能由管理员删除账号后重新发注册码（数据会一起删除），因为管理员看不到、也改不了别人的密码。

## 安全设计说明

账号相关：密码用 scrypt（N=2^17）加盐哈希，至少 10 位并拒绝常见弱密码。同一 IP 对同一账号连续错 5 次锁 15 分钟，之后每次翻倍、最长 24 小时；同一账号从所有 IP 累计错 30 次整体锁 15 分钟；登录接口按 IP 每 15 分钟 20 次。锁定期间即使密码正确也拒绝。"用户不存在"和"密码错误"的提示、耗时都一样，猜不出哪些用户名存在。注册码和登录令牌都是服务端生成的随机数（125 位、256 位），库里只存 SHA-256。

会话：网页版用 HttpOnly + SameSite=Strict Cookie，页面脚本读不到；https 模式下还带 `__Host-` 前缀和 Secure，只在加密连接上发送（http 模式没法加这两项）；桌面版令牌存系统凭据，前端脚本同样拿不到。30 天到期、7 天不用自动失效。改密码会踢掉其他设备，停用账号立即踢下线。

请求：所有改数据的请求必须带自定义头并且来源是本站（防跨站请求伪造），不响应任何 CORS；Host 头必须是配置的域名（防 DNS 重绑定和用 IP 直连）；有严格的 CSP、禁止被嵌入 iframe，https 模式下有 HSTS；请求体有大小上限；所有数据库查询都是参数化的；静态文件拒绝路径穿越。

数据：每个人的数据用 AES-256-GCM 加密后存盘，密文绑定了用户 ID 和版本号，挪到别人名下也解不开。服务端从不执行用户上传的 SQL，只存取加密后的字节。管理员没有任何接口能读别人的数据。

AI：只有超级管理员能添加服务商和模型，Key 加密存放、不回显；普通用户只能按 id 选已开启的模型，不能指定地址。每次连接服务商前都会检查域名解析出来的 IP，默认拒绝内网和本机地址，DNS 重绑定也绕不过去；不跟随重定向，响应大小有上限。转发时只保留认识的字段，图片只接受内嵌数据；每人每天、每分钟的调用次数有上限。

没有后门：代码里没有万能密码、调试开关、"以某用户身份登录"、管理员读数据或改别人密码的接口。服务端只用 Node 内置模块，没有第三方运行时依赖。`server/test/` 里的测试覆盖了上面这些攻击场景，可以用 `npm run test:server` 自己跑一遍。

http 模式下，上面这些防护（防暴力破解、防跨站请求、权限隔离、数据加密存盘）都照常生效，但挡不住"线路上偷看和篡改"：明文传输时，能监听网络的人可以直接拿到密码和登录凭证。这一点只有 https 能解决。

## 需要你自己注意的

服务器本身的安全不在这个项目的范围内，但很关键：SSH 只用密钥登录、关掉密码登录；系统和 Docker 定期更新；`deploy/.env` 权限 600，不要提交到 git。能登录服务器的人拥有一切权限（包括 `DATA_KEY`），所以服务器的登录权限就是最后一道门。

## 已经有 Nginx 的服务器

如果 80/443 已经被 Nginx（或宝塔面板）占用，又不想停掉它，可以让 Nginx 来转发：在 `docker-compose.yml` 里删掉两个 caddy 服务，给 `app` 加上 `ports: ["127.0.0.1:8787:8787"]`（只绑定本机，不对外），然后在 Nginx 里配置这个站点（证书在 Nginx 里配），转发时必须带上：

```nginx
client_max_body_size 60m;
location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
}
```

这种情况下 `.env` 里的 `COMPOSE_PROFILES` 仍然要按用户实际访问的方式填 https 或 http，应用靠它校验请求来源。
