# 库存管理系统（多人版）

一套可多人同时使用的商品与库存管理信息系统。采用 Node.js 内置 HTTP 与 SQLite（`node:sqlite`），**无需安装第三方 npm 依赖**。界面为简体中文，支持多仓库、供应商、条码、盘点、作废与操作日志。

要求 **Node.js 22.5 或更高版本**（推荐 24；Node 22 会自动加上 `--experimental-sqlite` 以启用内置 SQLite）。

## 快速开始

```bash
cd inventory-mis-server
npm install && npm start
```

默认监听 `0.0.0.0:3000`。在本机浏览器打开：

- http://127.0.0.1:3000

### 首次登录

- 如果数据库里还没有用户，启动时会自动创建管理员账号。
- 用户名默认 `admin`。
- 若设置了环境变量 `ADMIN_PASSWORD`，就使用该密码；否则程序会生成随机初始密码，并**醒目地打印在控制台**。请登录后立即修改密码。

加载演示数据后（需管理员在「数据」页操作）还会创建两个演示账号（若尚不存在）：

| 用户名 | 初始密码 | 角色 |
| --- | --- | --- |
| keeper | keeper123 | 库管员 |
| viewer | viewer123 | 只读 |

演示账号仅用于体验，上线前请修改或删除。

## 同事如何通过局域网访问

服务器启动后，控制台会打印本机局域网地址，例如：

```
局域网访问: http://192.168.1.23:3000
```

请确保：

1. 使用 `npm start` 默认监听 `0.0.0.0`（不要改成只监听 127.0.0.1）。
2. 本机防火墙放行 3000 端口（如 `ufw allow 3000/tcp`）。
3. 同事与服务器在同一局域网，用上述地址访问即可。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `DATA_DIR` | 项目下的 `data/` | 数据库目录 |
| `ADMIN_USERNAME` | `admin` | 首次创建的管理员用户名 |
| `ADMIN_PASSWORD` | （空则随机生成） | 首次创建的管理员密码 |
| `AUTO_DEMO` | 未设置 | 设为 `1` 时，若启动时数据库中还没有商品和出入库记录，则自动加载演示数据并创建演示账号 |
| `SESSION_DAYS` | `7` | 登录会话有效天数 |
| `FORCE_SECURE_COOKIE` | 未设置 | 设为 `1` 时 Cookie 带 `Secure`（在 HTTPS 反代后使用） |

会话 Cookie 为 `HttpOnly`、`SameSite=Lax`。若站点通过 HTTPS 反代访问，请设置 `X-Forwarded-Proto: https` 或 `FORCE_SECURE_COOKIE=1`。

开发时可使用：

```bash
npm run dev    # 等价于 node --watch src/server.js，改代码后自动重启
```

## 数据文件与备份

- 数据库文件：`data/inventory.db`（可用 `DATA_DIR` 更改目录）。
- 采用 SQLite WAL 模式，同目录下可能出现 `inventory.db-wal`、`inventory.db-shm`，备份时请一并复制，或先停止服务再拷贝 `inventory.db`。
- 建议定期在系统「数据」页导出 JSON 备份，并用 Excel 可打开的 CSV 做台账存档。
- 管理员导入 JSON 会**覆盖**当前业务数据（商品、仓库、库存、单据等），默认**不会覆盖已有用户账号**。

手动备份示例：

```bash
# 建议先停止服务再拷贝
cp data/inventory.db /backup/inventory-$(date +%F).db
```

## 角色与权限

| 角色 | 权限 |
| --- | --- |
| 管理员 | 全部功能：用户管理、作废单据、JSON 备份/恢复、加载演示数据、清空业务数据，以及库管员的全部操作 |
| 库管员 | 商品/分类/仓库/供应商维护，出入库、调拨、盘点，导出 CSV |
| 只读 | 查看各页面、导出 CSV，不能改数据 |

权限在服务器端强制校验，不能靠隐藏按钮绕过。

## 主要功能

- 仪表盘：SKU 数、库存总量、库存成本、低库存预警，以及各仓库汇总
- 商品管理：编码唯一，搜索/筛选/排序，低库存高亮
- 多仓库库存、仓库间调拨；出库不可超过**该仓库**库存
- 供应商，入库可关联供应商
- 出入库单据可由管理员作废（回滚库存并记录原因）
- 盘点：按仓库录入实盘数量，系统按差异调整并记一笔盘点单
- 商品 Code 128 条码（浏览器内生成，无需外网），可打印标签；顶栏支持扫码/输入编码查找
- 操作日志
- 库存更新使用 SQLite 事务（`BEGIN IMMEDIATE`），避免并发超卖

## 使用 Docker 运行

```bash
cd inventory-mis-server
# 可选：指定首个管理员密码
export ADMIN_PASSWORD='请改成强密码'
docker compose up -d --build
```

数据默认挂载到项目下的 `./data`。查看首次密码（若未设置 `ADMIN_PASSWORD`）：

```bash
docker compose logs inventory | less
```

## 部署到云服务器（以 PM2 为例）

1. 安装 Node.js 22+（推荐 [NodeSource](https://github.com/nodesource/distributions) 或 nvm）。
2. 把项目拷到服务器，例如 `/opt/inventory-mis-server`。
3. 安装并启动 PM2：

```bash
cd /opt/inventory-mis-server
npm install
# 建议用环境变量设置管理员密码（仅首次创建用户时生效）
export ADMIN_PASSWORD='请改成强密码'
npx pm2 start src/server.js --name inventory-mis --env production
npx pm2 save
npx pm2 startup    # 按提示设置开机自启
```

4. 如需域名和 HTTPS，用 Nginx 反代到 `http://127.0.0.1:3000`，并传递：

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

5. 云防火墙 / 安全组放行 80、443（若用 Nginx）或 3000 端口。

也可用 Docker Compose 在云主机上直接 `docker compose up -d`。


## 部署到 Render（免费套餐）

本仓库包含 `render.yaml`，适合课堂演示。Render 免费套餐**没有持久磁盘**，实例休眠或重新部署后数据库会被清空。因此 Blueprint 里默认设置了 `AUTO_DEMO=1`：每次空库启动时自动写入演示数据。

1. 将本仓库推送到 GitHub / GitLab，在 [Render](https://render.com) 用 **Blueprint** 导入该仓库，或新建 Web Service 并指向仓库。
2. 构建命令为 `npm install`，启动命令为 `npm start`。Node 版本通过环境变量 `NODE_VERSION=22` 指定（需 22.5+，以便使用内置 `node:sqlite`）。
3. 在 Render 控制台为 `ADMIN_PASSWORD` 填入管理员密码（Blueprint 中该变量为 `sync: false`，需要你手动设置）。`AUTO_DEMO` 已设为 `1`。
4. 部署完成后打开 Render 分配的 `*.onrender.com` 地址即可使用。

登录说明：

- 管理员：用户名 `admin`，密码为你设置的 `ADMIN_PASSWORD`。
- 演示库管员：`keeper` / `keeper123`
- 演示只读：`viewer` / `viewer123`

注意：免费实例一段时间无访问可能会休眠；醒来或重新部署后若文件系统被重置，会再次自动加载演示数据。不要把正式业务数据只放在免费套餐上。

## 项目结构

```
inventory-mis-server/
  src/            服务器（HTTP、鉴权、API、SQLite）
  public/         前端页面、样式与条码脚本
  data/           数据库目录（inventory.db）
  Dockerfile
  docker-compose.yml
```

本项目运行时不依赖任何 npm 包，`npm install` 仅是为了统一启动方式。
