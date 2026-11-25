# 部署到服务器

需要：一台 Linux 服务器（1 核 1G 内存够用）、Docker 和 Docker Compose。用「https + 域名」还需要一个域名。

## 0. 先选访问方式

在 `deploy/.env` 里用 `COMPOSE_PROFILES` 选，三选一，默认是 `https-ip`：

| | `https-ip`：https + IP + 端口（默认） | `https`：https + 域名 | `http`：不加密 |
|---|---|---|---|
| 访问地址 | `https://服务器IP:8443` | `https://你的域名` | `http://你的域名或IP` |
| 传输 | 加密 | 加密 | **不加密，明文** |
| 证书 | 自动向 Let's Encrypt 申请 IP 证书；申请不到时用自签名证书，各设备要手动信任一次 | 自动申请免费证书 | 不需要 |
| 需要 | 公网 IPv4，80 端口和访问端口（默认 8443）能从公网访问 | 域名；80、443 端口能从公网访问 | 80 端口 |
| 适合 | 没有域名、小范围使用 | 公网长期使用 | 内网、局域网、临时测试 |

三种方式下，账号、防暴力破解、防跨站请求、数据加密存盘这些防护都一样。区别只在"网络上传输的这一段"有没有加密、证书是谁签的。

**https-ip 的证书怎么来的：** Caddy 启动后先向 Let's Encrypt 申请这个 IP 的证书。Let's Encrypt 从 2026 年 1 月起正式签发 IP 证书，有效期约 6 天，Caddy 会自动续期，不用管。申请时 Let's Encrypt 会从公网访问服务器的 80 端口，确认这个 IP 是你的，所以 80 端口必须开着、没被占用。申请成功的话，浏览器和桌面版直接就能用，和域名证书一样。申请不到（80 端口不通、被拦截等）时，Caddy 自动改用它自己签发的证书（自签名）。这时打开网页会提示"不安全"，需要按第 7 步在每台设备上信任一次。之后 Caddy 每隔几个小时会重新尝试 Let's Encrypt，成功后自动换成正式证书。

**http 方式的风险，请先看清楚再选：** 登录密码、登录凭证、所有聊天记录和复盘内容、管理员在网页上填的 API Key，在网络上都是明文传输。和你连同一个 Wi-Fi 的人、运营商、路上经过的任何一台设备都能看到，也能偷偷改掉网页内容。服务器启动日志会打印这条提醒，网页登录页和桌面版也会提示。用 http 时请至少做到：密码不要和其他网站重复；不在公共 Wi-Fi 下登录；API Key 设置消费上限，能的话在内网或通过 VPN 访问。

**关于备案（服务器在中国大陆时）：** 按规定，在中国大陆的服务器上对外提供网站服务需要备案，这一点和用域名还是 IP、用不用证书、用 http 还是 https 都无关。实际执行上，阿里云、腾讯云等是按域名检查的：没备案的域名 http 和 https 都会被拦截（http 返回一个"未备案"提示页，https 直接断开）。用 IP 访问通常不会被这样拦截，但并不代表符合规定，云厂商发现后可能要求整改，或者限制这台服务器。是否这样用请你自己判断。合规的做法是：给域名备案后用 `https`；或者换一台中国香港、海外的服务器，三种方式都可以用。

## 1. 准备

**共同的一步：检查端口有没有被占用。** 在服务器上运行 `ss -ltnp | grep -E ':(80|443|8443) '`，有输出就说明被占了（常见的是服务器自带的 Nginx、宝塔面板）。先停掉它，或者换一个访问端口（https-ip 方式改 `HTTPS_PORT`），或者让它来转发（见文末「已经有 Nginx 的服务器」）。80 端口三种方式都要用。

**https-ip 方式（默认）：**

1. 在云服务器控制台找到服务器的**公网 IP**，填到 `deploy/.env` 的 `SERVER_IP`。不要填 `ifconfig` 里看到的 `172.x`、`10.x` 这类内网地址。只支持 IPv4。
2. 安全组（控制台里的防火墙）放行 TCP 80、TCP 8443、UDP 8443（改了 `HTTPS_PORT` 就放行你改的那个）。
3. 大家访问的地址是 `https://SERVER_IP:HTTPS_PORT`，例如 `https://47.100.1.2:8443`，必须带 `https://` 和端口。
4. 服务器换了公网 IP 的话，要改 `SERVER_IP` 并重启；之前信任过的自签名证书不用重新信任，但地址变了，桌面版要在登录页点「更换」填新地址。

**https 方式：**

1. 域名解析：在域名服务商那里给你要用的域名加 A 记录（有 IPv6 的话再加 AAAA），指向服务器公网 IP。`DOMAIN` 填的是哪个就解析哪个：填 `example.com` 要解析 `@`，填 `memo.example.com` 要解析 `memo`。`www` 和不带 `www` 是两个不同的地址，各自要有记录。
2. 确认解析生效：在自己电脑上 `ping 你的域名`，显示的 IP 要是服务器的 IP。
3. 安全组放行 TCP 80、TCP 443、UDP 443。Caddy 申请证书时，证书机构会从公网访问 80 或 443 端口来验证域名是你的，所以 80 也必须开着。
4. 已经买了证书的话不用管它，Caddy 会自动申请免费证书（Let's Encrypt / ZeroSSL），每 60 天左右自动续期，不需要上传证书文件。

**http 方式：** 只需要 80 端口能访问。`DOMAIN` 填访问时地址栏里的域名或 IP。

服务器防火墙只开需要的端口（下面是 https-ip 的例子；https 方式把 8443 换成 443，http 方式只开 80）：

```bash
ufw default deny incoming
ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 8443/tcp && ufw allow 8443/udp
ufw enable
```

注意：Docker 发布的端口会绕过 ufw。本项目只发布 Caddy 的端口，应用本身的 8787 端口不对外，所以没有影响。不要自己在 compose 里给 `app` 加 `ports:`。

## 2. 配置

```bash
git clone <你的仓库> lovememo && cd lovememo
cp deploy/.env.example deploy/.env
openssl rand -base64 32        # 把输出填到 deploy/.env 的 DATA_KEY
nano deploy/.env               # 选 COMPOSE_PROFILES，填 SERVER_IP（https-ip）或 DOMAIN（https/http），再填 DATA_KEY
chmod 600 deploy/.env
```

`DATA_KEY` 用来加密所有人的数据，以及你在网页上填的各家 API Key。**它丢了，数据就再也解不开；它泄露了，拿到数据文件的人就能解开。** 请另外找个安全的地方（比如密码管理器）存一份，并且不要和数据备份放在一起。

AI 的端点地址和 API Key 不写在配置文件里，启动后在网页上添加（见第 4 步）。

## 3. 启动

```bash
docker compose -f deploy/docker-compose.yml up -d --build
docker compose -f deploy/docker-compose.yml logs app
```

`up` 会按 `COMPOSE_PROFILES` 只启动对应的那个 Caddy（`caddy-ip`、`caddy` 或 `caddy-http`）。

**https-ip 方式**第一次启动时，看 Caddy 的日志确认拿到的是哪种证书：

```bash
docker compose -f deploy/docker-compose.yml logs -f caddy-ip
```

找 `certificate obtained successfully` 这一行：后面的 `issuer` 是 `acme-v02.api.letsencrypt.org-directory`，说明拿到了 Let's Encrypt 的正式证书，直接打开网址就能用；是 `local`，说明用的是自签名证书，请按第 7 步让各设备信任。日志里有 `could not get certificate from issuer` 和 Let's Encrypt 的报错，一般是 80 端口从公网访问不到（安全组没开、被占用、被拦截），修好后重启 Caddy（`docker compose -f deploy/docker-compose.yml restart caddy-ip`）会马上重试。也可以直接用浏览器打开 `https://IP:端口`，没有"不安全"提示就是正式证书。

**https 方式**第一次启动时，Caddy 要花几秒到一两分钟申请证书：

```bash
docker compose -f deploy/docker-compose.yml logs -f caddy
```

看到 `certificate obtained successfully` 就好了。如果一直报错，最常见的原因是：域名还没解析到这台服务器、安全组没开 80/443、80/443 被别的程序占着、服务器在中国大陆而域名没备案。

两种 https 方式都要注意：同一个域名或 IP 短时间内申请失败太多次，Let's Encrypt 会暂时限制申请（大约每小时 5 次），修好问题后等一会儿再试。

应用的日志里会有一段：

```
================ 首次安装 ================
打开 https://47.100.1.2:8443 ，用下面的安装码创建超级管理员：

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

桌面版第一次打开时填服务器地址，然后用同一个账号登录，数据和网页版是同一份。登录凭证存在系统凭据管理器里。

地址的写法：https-ip 方式填 `https://47.100.1.2:8443`（必须带端口）；https 方式填 `https://你的域名`；http 方式填 `http://你的域名或IP`，桌面版会提示连接不加密，勾选确认后才能连接。

https-ip 用的是自签名证书时，桌面版第一次连接会提示"服务器的证书没有通过检查"，按第 7 步导入证书就好。



## 7. 自签名证书：让各设备信任一次（只有 https-ip 申请不到正式证书时才需要）

如果 https-ip 方式拿到的是自签名证书（第 3 步日志里 `issuer` 是 `local`，或者浏览器提示"不安全"），需要把 Caddy 的**根证书**发给每个使用者，在他们的设备上信任一次。之后 Caddy 自动换发的证书都由这个根证书签发，不用再操作。

**导出根证书（在服务器上）：**

```bash
docker compose -f deploy/docker-compose.yml cp caddy-ip:/data/caddy/pki/authorities/local/root.crt ./root.crt
openssl x509 -in root.crt -noout -fingerprint -sha256     # 记下这串指纹
```

把 `root.crt` 发给对方（微信、U 盘都行，它是公开的，不含私钥），再通过**另一个渠道**（比如当面或打电话）把指纹告诉对方，让对方核对。这样就算文件在路上被人换掉，也能发现。

**桌面版：** 在连接服务器的页面点「管理员给了你一个证书文件？」→「选择证书文件」，选 `root.crt`，核对显示的指纹和你给的一样，再点「连接」。这张证书只给桌面版自己用，不会装进系统，也不影响电脑上其他软件。已经连过的，在登录页点「更换」，或者在"连不上服务器"的页面点「更换服务器或导入证书」。

**浏览器（网页版）：** 需要把根证书装进系统，才能不再提示"不安全"。

1. Windows：双击 `root.crt` →「安装证书」→ 选「当前用户」→「将所有的证书都放入下列存储」→ 浏览 → 选「受信任的根证书颁发机构」→ 完成，弹出安全警告时核对指纹后点「是」。然后重启浏览器。
2. macOS：双击 `root.crt` 加入「钥匙串访问」→ 找到「Caddy Local Authority」→ 双击 → 展开「信任」→「使用此证书时」选「始终信任」。
3. iPhone / iPad：用 Safari 或"文件"打开 `root.crt` → 设置里出现「已下载描述文件」→ 安装 → 再到「设置 → 通用 → 关于本机 → 证书信任设置」里打开它的开关。
4. 安卓：设置 → 安全（或"安全与隐私"）→ 更多安全设置 → 加密与凭据 → 安装证书 →「CA 证书」→ 选 `root.crt`。各品牌菜单名字略有不同，可以在设置里搜"CA 证书"。

**请一定了解这个风险：** 装进系统的根证书，系统会用它来相信**任何网站**的证书，不只是这台服务器。根证书的私钥在服务器的 `caddy-data` 卷里，所以能登录这台服务器的人，理论上可以冒充别的网站骗过这些设备。只在你信任服务器管理员的设备上安装；不用了就删掉（Windows 运行 `certmgr.msc`，在「受信任的根证书颁发机构 → 证书」里删除「Caddy Local Authority」；手机在同一个菜单里删除）。桌面版导入证书没有这个问题，所以能用桌面版的话优先用桌面版。

**不要**在浏览器的"不安全"提示页直接点「继续前往」来用：这样浏览器不检查证书，被人冒充时你也看不出来，和用 http 差不多。

`caddy-data` 卷不要删。删了之后 Caddy 会生成新的根证书，所有人要重新信任一次。

## 8. 备份

数据都在 Docker 卷 `lovememo_app-data` 里（账号库 `server.sqlite` 和加密的用户数据 `userdata/`）。

```bash
# 每天备份一次（加进 crontab）
docker run --rm -v lovememo_app-data:/data -v /root/backup:/backup alpine \
  tar czf /backup/lovememo-$(date +%F).tgz -C /data .
```

恢复时把压缩包解回卷里，并且用**同一个** `DATA_KEY` 启动。

每个用户最近 3 个版本的数据都保留在 `userdata/<用户ID>/` 下，误操作时可以在服务器上手动删掉最新的那个 `.bin`、把 `server.sqlite` 里该用户的 `data_version` 改回上一个数字来回滚。

## 9. 更新

```bash
git pull
docker compose -f deploy/docker-compose.yml up -d --build
```

## 10. 切换访问方式

改 `deploy/.env` 里的 `COMPOSE_PROFILES` 之后，要先把旧的全部停掉再启动，否则旧的 Caddy 还占着端口：

```bash
docker compose -f deploy/docker-compose.yml --profile https-ip --profile https --profile http down   # 不要加 -v，加了会删数据
docker compose -f deploy/docker-compose.yml up -d
```

数据、账号都不受影响。访问地址变了，所以所有人都要重新登录一次（不同地址的登录凭证不通用），桌面版要在登录页点「更换」改一下服务器地址。

从 https 换回 http 时注意：浏览器访问过 https 版之后会记住"这个域名只用 https"（一年），之后再用 http 打开会被浏览器自动改成 https。所以同一个域名最好定下来就不要来回换。（用 IP 访问时浏览器不记这个，没有影响。）

## 11. 忘记管理员密码

网页上没有"找回密码"，也没有任何能绕过密码的入口。只有能登录服务器的人可以重设超级管理员的密码：

```bash
docker compose -f deploy/docker-compose.yml exec -it app node server/src/cli.ts reset-admin-password
```

这个命令只能改超级管理员自己的密码，改完后管理员在所有设备上都会退出登录，并且会记进安全日志。普通用户忘了密码，只能由管理员删除账号后重新发注册码（数据会一起删除），因为管理员看不到、也改不了别人的密码。

## 安全设计说明

账号相关：密码用 scrypt（N=2^17）加盐哈希，至少 10 位并拒绝常见弱密码。同一 IP 对同一账号连续错 5 次锁 15 分钟，之后每次翻倍、最长 24 小时；同一账号从所有 IP 累计错 30 次整体锁 15 分钟；登录接口按 IP 每 15 分钟 20 次。锁定期间即使密码正确也拒绝。"用户不存在"和"密码错误"的提示、耗时都一样，猜不出哪些用户名存在。注册码和登录令牌都是服务端生成的随机数（125 位、256 位），库里只存 SHA-256。

会话：网页版用 HttpOnly + SameSite=Strict Cookie，页面脚本读不到；两种 https 方式下还带 `__Host-` 前缀和 Secure，只在加密连接上发送（http 方式没法加这两项）；桌面版令牌存系统凭据，前端脚本同样拿不到。30 天到期、7 天不用自动失效。改密码会踢掉其他设备，停用账号立即踢下线。

请求：所有改数据的请求必须带自定义头并且来源是本站（防跨站请求伪造），不响应任何 CORS；Host 头必须和配置的访问地址一致（防 DNS 重绑定，也防止绕开配置的地址直连）；有严格的 CSP、禁止被嵌入 iframe，https 方式下有 HSTS；请求体有大小上限；所有数据库查询都是参数化的；静态文件拒绝路径穿越。

数据：每个人的数据用 AES-256-GCM 加密后存盘，密文绑定了用户 ID 和版本号，挪到别人名下也解不开。服务端从不执行用户上传的 SQL，只存取加密后的字节。管理员没有任何接口能读别人的数据。

AI：只有超级管理员能添加服务商和模型，Key 加密存放、不回显；普通用户只能按 id 选已开启的模型，不能指定地址。每次连接服务商前都会检查域名解析出来的 IP，默认拒绝内网和本机地址，DNS 重绑定也绕不过去；不跟随重定向，响应大小有上限。转发时只保留认识的字段，图片只接受内嵌数据；每人每天、每分钟的调用次数有上限。

没有后门：代码里没有万能密码、调试开关、"以某用户身份登录"、管理员读数据或改别人密码的接口。服务端只用 Node 内置模块，没有第三方运行时依赖。`server/test/` 里的测试覆盖了上面这些攻击场景，可以用 `npm run test:server` 自己跑一遍。

https-ip 用自签名证书时，加密和 https 一样，区别是证书由你自己的服务器签发，靠"每台设备手动信任一次"来防冒充（见第 7 步），所以信任之前一定要核对指纹。

http 方式下，上面这些防护（防暴力破解、防跨站请求、权限隔离、数据加密存盘）都照常生效，但挡不住"线路上偷看和篡改"：明文传输时，能监听网络的人可以直接拿到密码和登录凭证。这一点只有 https 能解决。

## 需要你自己注意的

服务器本身的安全不在这个项目的范围内，但很关键：SSH 只用密钥登录、关掉密码登录；系统和 Docker 定期更新；`deploy/.env` 权限 600，不要提交到 git。能登录服务器的人拥有一切权限（包括 `DATA_KEY`），所以服务器的登录权限就是最后一道门。

## 已经有 Nginx 的服务器

如果 80/443 已经被 Nginx（或宝塔面板）占用，又不想停掉它：用 https-ip 方式的话，最简单的是把 `HTTPS_PORT` 换成没被占用的端口，但申请 Let's Encrypt 证书要用的 80 端口仍然被占着，只能用自签名证书。也可以让 Nginx 来转发：在 `docker-compose.yml` 里删掉三个 caddy 服务，给 `app` 加上 `ports: ["127.0.0.1:8787:8787"]`（只绑定本机，不对外），然后在 Nginx 里配置这个站点（证书在 Nginx 里配），转发时必须带上：

```nginx
client_max_body_size 60m;
location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host $http_host;   # 带端口，不要用 $host
    proxy_set_header X-Forwarded-For $remote_addr;
}
```

这种情况下 `.env` 里的 `COMPOSE_PROFILES` 仍然要按用户实际访问的方式填（https-ip、https 或 http），`SERVER_IP`、`HTTPS_PORT`、`DOMAIN` 也要和实际地址一致，应用靠它们校验请求来源。
