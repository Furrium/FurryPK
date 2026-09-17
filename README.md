# FurSonic · FurryPK SUPER Edition

浏览器多人 FPS。three.js r128 + WebSocket 权威服务端,无构建步骤、无 npm 依赖,`docker compose up` 即可跑。

---

## 快速开始

```bash
git clone <你的仓库地址> fps-online-game
cd fps-online-game

cp .env.example .env
# 编辑 .env —— 至少改 PORT 和 NodeLoc_REDIRECT_URI

docker compose up -d --build
```

打开 `http://localhost:3066`。

> **首次一定加 `--build`**。`public/` 和 `server/` 是在构建时 COPY 进镜像的,
> 不是挂载卷 —— 改完代码不加 `--build` 等于没改。这是本项目最容易踩的坑。

---

## 目录结构

```
.
├── public/                  # 前端(浏览器直接加载,无打包)
│   ├── index.html           # 单页入口
│   ├── js/
│   │   ├── game.js          # 主逻辑:渲染循环 / 玩法 / 网络同步
│   │   ├── postfx.js        # 后期处理:泛光 / 暗角 / 调色(EffectComposer)
│   │   ├── ground-fx.js     # 地面特效
│   │   ├── ground-mirror.js # 地面镜面反射(Reflector)
│   │   ├── decor.js         # 场景装饰物(纯视觉,无碰撞)
│   │   ├── fog-event.js     # 浓雾事件(客户端表现)
│   │   ├── net.js           # WebSocket 客户端
│   │   └── ...
│   ├── lib/                 # 第三方库(本地存放,不用 CDN)
│   │   ├── three.min.js     # three.js r128 (UMD)
│   │   ├── GLTFLoader.js
│   │   ├── objects/         # Reflector.js
│   │   ├── postprocessing/  # EffectComposer / RenderPass / UnrealBloomPass ...
│   │   └── shaders/         # Copy / LuminosityHighPass / FXAA
│   ├── data/
│   │   └── arena-decor.json # 装饰物布局(27 项)
│   ├── models/              # glTF 模型(武器等)
│   ├── textures/  sounds/   # 贴图与音效
│   └── css/
│
├── server/                  # 权威服务端(Node.js,无框架,原生 http + ws)
│   ├── index.js             # 入口:HTTP 静态服务 + WebSocket + 游戏循环
│   ├── config.js            # ★ 全部数值配置都在这(武器/装备/地图/规则/雾事件)
│   ├── world.js             # 地图碰撞 / 出生点 / 快照序列化
│   ├── physics.js           # 移动与碰撞解算
│   ├── rooms.js             # 房间与状态机
│   ├── oauth-nodeloc.js     # NodeLoc OAuth 登录(可选)
│
├── Dockerfile
├── docker-compose.yml
├── .env.example             # ★ 部署前先看这里
└── data/                    # 运行时生成(玩家档案/聊天记录),已在 .gitignore
```

---

## 必须设置的环境变量

完整模板见 `.env.example`。**只有 NodeLoc OAuth 是真正需要外部凭据的**,
不配也能启动,只是登录入口不可用。

| 变量 | 必填 | 说明 |
|---|---|---|
| `PORT` | 否 | 监听端口,默认 `3066` |
| `DATA_DIR` | 否 | 持久化目录,默认 `/app/data` |
| `NODELOC_CLIENT_ID` | 登录才需要 | NodeLoc OAuth 应用 ID |
| `NODELOC_CLIENT_SECRET` | 登录才需要 | NodeLoc OAuth 应用密钥 |
| `NodeLoc_REDIRECT_URI` | 登录才需要 | 回调地址,**必须与后台注册的完全一致** |
| `NodeLoc_SCOPE` | 否 | 默认 `openid profile` |
| `COOKIE_SECURE` | 否 | 留空自动判断(https→开启) |

**没有 NodeLoc 应用怎么办**:去 NodeLoc 的 OAuth 应用管理页创建一个,
回调地址填 `https://你的域名/oauth/nodeloc`。或者干脆不配 —— 游戏本体
(移动/射击/计分)不依赖登录,只有账号相关的功能会关闭。

### 换掉 NodeLoc 也行

`server/oauth-nodeloc.js` 是独立模块,实现标准 OAuth2 授权码流程。
接别的身份提供方只需替换这一个文件,其余代码通过 `server/index.js`
里注册的 `/oauth/*` 路由调用,不关心具体实现。

---

## 反代与 HTTPS

游戏包含需要安全上下文的浏览器 API,**线上必须走 HTTPS**。
nginx 参考配置:

```nginx
server {
    listen 443 ssl http2;
    server_name your-domain.example;

    ssl_certificate     /etc/letsencrypt/live/your-domain.example/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.example/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3066;
        proxy_http_version 1.1;
        proxy_set_header Upgrade    $http_upgrade;   # WebSocket 必需
        proxy_set_header Connection "upgrade";       # WebSocket 必需
        proxy_set_header Host       $host;
        proxy_set_header X-Real-IP  $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 7d;                       # 长连接别被掐
    }
}
```

> ⚠️ 用公网 IP + 纯 HTTP 访问会导致站点白屏 —— 不是 bug,是浏览器安全策略。
> 本地开发用 `http://localhost` 是例外(localhost 被视为安全上下文)。

---

## 调参

绝大多数数值集中在 `server/config.js`,改完重启容器生效。

### 客户端调试用 URL 参数

方便实时对比效果,不需要改代码:

| 参数 | 作用 | 默认 |
|---|---|---|
| `?fx=0` | 关闭全部后期处理 | 开 |
| `?bloom=0.1` | 泛光强度 | `0.1` |
| `?thr=0.8` | 泛光阈值 | — |
| `?con=` `?sat=` | 对比度 / 饱和度 | — |
| `?vig=` | 暗角强度 | — |
| `?exp=` | 曝光 | — |
| `?mmix=0.45` | 地面镜面混合 | `0.45` |
| `?mblur=2.0` | 镜面模糊半径 | `2.0` |
| `?mres=` | 镜面分辨率 | — |
| `?grid=1` `?gridcol=` | 调试网格 / 网格颜色 | 关 |
| `?decor=0` | 关闭装饰物 | 开 |
| `?fogNear=` `?fogFar=` | 雾的近/远平面 | `3` / `26` |
| `?fogBlobs=` | 雾团数量 | `40` |
| `?fogevent=0` | 关闭浓雾事件 | 开 |

例:`https://your-domain.example/?bloom=0.4&decor=0`

### 浓雾事件

`server/config.js` → `FOG_EVENT`:

```js
{ enabled: true, minGap: 75, maxGap: 210, duration: 45, warnLead: 6 }
```

服务端每秒 tick 一次,随机在 `[minGap, maxGap]` 秒后触发,持续 `duration` 秒,
提前 `warnLead` 秒广播前兆。状态由 `global.__fogDense` 承载,随世界快照
下发给客户端(`server/world.js`),客户端在 `public/js/fog-event.js` 里
做雾的密度插值(淡入 4s / 淡出 7s)。

---

## 常见问题

**改了代码没效果。**
`docker compose up -d --build --force-recreate`。`public/` 和 `server/`
在构建期被 COPY 进镜像,不加 `--build` 不会更新。

**站点白屏 / 控制台报 `self.GPUShaderStage is undefined`。**
你在用公网 IP 走 HTTP 访问。必须 HTTPS 或 localhost。

**登录按钮没反应。**
`NODELOC_CLIENT_ID` / `NODELOC_CLIENT_SECRET` 没配,或
`NodeLoc_REDIRECT_URI` 与 NodeLoc 后台注册值不一致。

**容器起来后立刻退出。**
看 `docker compose logs`。多半是 `.env` 里 `PORT` 被别的进程占了。

**`其他/` 目录哪去了。**
那是 `public/models/pistol.glb` 的重复副本(11 MB),已从仓库移除并写进
`.gitignore`。需要模型请用 `public/models/pistol.glb`。

---

## 部署清单(换机器时照着走)

1. `git clone` 到新机器
2. `cp .env.example .env`,填 `NodeLoc_*`(不用登录可跳过)
3. `docker compose up -d --build`
4. nginx 反代 + 证书(注意 WebSocket 的 `Upgrade` / `Connection` 头)
5. NodeLoc 后台把回调地址改成新域名

`data/` 目录是唯一需要迁移的运行时数据(玩家档案 / 聊天记录 / 反作弊记录),
不在 git 里,手动拷过去即可。

---

## 许可

代码仅供学习交流。使用的第三方库(three.js 等)遵循其各自许可证。

本项目二次开发于[Zard's 零区冲突](https://github.com/ZardQAQ/fps-online-game)。
