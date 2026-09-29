# 同机独立部署闲鱼管家

本方案让闲鱼管家与账号分发系统使用不同的 Compose 项目、容器、数据目录和日志目录。闲鱼管家的后台只绑定服务器 `127.0.0.1:18080`。取码走 Docker 内网：

`xianyu-app → delivery-gateway:8081 → backend:8080`

`delivery-gateway` 是闲鱼项目内的 Caddy 容器，不发布宿主机端口，只转发 `POST /api/delivery/codes` 和 `GET /api/delivery/pools`；账号系统原有容器和 Compose 文件不需要修改。账号系统后端仍会验证专用 Bearer 令牌。账号系统的公网入口保持原有规则，不开放账号池列表接口。

## 上线前准备

1. 确认账号系统 Compose 网络名为 `account-distribution_default`，其后端容器在该网络中能以 `backend:8080` 访问。若服务器环境不同，修改 `docker-compose.server.yml` 的外部网络名和 Caddyfile 的后端地址后再部署。
2. 确保服务器有足够资源。管家镜像保留 Playwright、Chromium 和 Xvfb；构建镜像的内存峰值可能高于服务器现有的约 2.6 GiB 可用内存。必要时增加临时 swap、限制构建并行度或在别处构建后导入镜像。运行期另有浏览器峰值；当前配置将应用容器内存限制为 2300 MiB，需结合实际服务器负载监测。
3. 服务器若无法直连 Docker Hub，服务器专用的 `deploy/server.Dockerfile` 已将 Python、Node 基础镜像改为官方 Public ECR 镜像；网关默认也从 Public ECR 拉取 Caddy。构建中的 apt、pip、npm 和 Chromium 使用国内镜像。如果服务器同样无法访问 Public ECR，可先在可访问的机器上拉取所需镜像并 `docker save` / `docker load`，或从私有仓库加载后调整服务器 Dockerfile 的 `FROM` 和 `.env.server` 中的 `XIAN_YU_CADDY_IMAGE`。
4. 整理并固定要部署的代码版本，尤其要包含当前多份发货和手动发货修复。不要从旧版仓库直接构建。
5. 本机管家仍运行时，先迁移数据库副本和做网络检查，暂不启动服务器的 `xianyu-app`，避免两处监听同一闲鱼账号。

## 准备私有数据

在服务器的管家代码目录复制 `deploy/server.env.example` 为 `.env.server`，填入独立的绝对路径和非默认 `ADMIN_PASSWORD`，并设文件权限为 `600`。`.env.server` 已被 Git 忽略。首次建库才使用 `ADMIN_PASSWORD`；迁移已有数据库不会据此修改管理员密码。当前本机数据库的管理员仍用默认密码，因此迁移时必须另备一个权限为 `600` 的私有密码文件，用 `--new-admin-password-file` 只修改迁移副本中的管理员密码；把同一个新密码填进 `.env.server`。该文件和 `.env.server` 都不要提交或输出到日志。

在服务器创建 `${XIAN_YU_STATE_DIR}` 下的 `data`、`logs`、`backups`、`uploads` 四个目录。完整迁移本机 `static/uploads/` 到 `uploads/`，并保留需要的旧备份。不要将数据库、Cookie、卡密、Bearer 令牌或 `.env.server` 提交到 Git。

下面的数据库命令要在**正式切换时**执行：先停止本机 `Start.py`，再用 SQLite 备份接口取得本机 `data/xianyu_data.db` 的最终一致性快照并传到服务器私有暂存目录。不要在本机仍写入时直接复制 `.db` 文件而遗漏 WAL，也不要把提前制作的旧快照当作最终数据。

```bash
python3 scripts/prepare_server_db.py /private/staging/xianyu_data.db /srv/xianyu-manager/data/xianyu_data.db --new-admin-password-file /private/staging/admin-password
```

脚本只把 `cards.api_config` 中恰好等于 `https://91zhajinwanyi.cn/api/delivery/codes` 的 API 卡券 `url` 改为 `http://delivery-gateway:8081/api/delivery/codes`，并在迁移副本中关闭注册和默认登录提示。它不会打印卡券配置或令牌，也不会改发码身份、时长、订单记录。若源库中没有该地址或仍用默认管理员密码且未提供新密码文件，脚本会失败并移除未完成的目标副本。原始备份保留用于回滚。

`USER_REGISTRATION_ENABLED=false` 仅作为显式配置；真正的注册开关保存在 SQLite `system_settings`，迁移脚本已修改它。上线后还要在后台“设置 → 访问与安全”核对注册已关闭。

## 构建、验证、切换

以下命令均在闲鱼管家的代码目录执行。`live` profile 防止普通 `docker compose up` 意外启动监听器。先只构建镜像、启动网关：

```bash
docker compose --env-file .env.server -f docker-compose.server.yml --profile live config --quiet
docker compose --env-file .env.server -f docker-compose.server.yml --profile live build xianyu-app
docker compose --env-file .env.server -f docker-compose.server.yml --profile live up -d delivery-gateway
```

网关无宿主机端口。可以使用已构建的应用镜像发起一次不带凭据的网络检查；`GET /api/delivery/pools` 和 `POST /api/delivery/codes` 可到达后端并因缺少凭据被拒绝，其他路径或方法由网关返回 404。不要用真实订单做连通性探针，也不要在命令或日志中打印 Bearer 令牌。

切换时先停本机 `Start.py`，确认旧监听器退出，再制作并迁移上一节所述的最终数据库快照及上传文件。确认目标数据完整后启动服务器应用：

```bash
docker compose --env-file .env.server -f docker-compose.server.yml --profile live up -d xianyu-app
docker compose --env-file .env.server -f docker-compose.server.yml --profile live ps
docker compose --env-file .env.server -f docker-compose.server.yml --profile live logs --tail=100 xianyu-app
curl -fsS http://127.0.0.1:18080/health
```

本机通过 SSH 隧道打开管理后台：

```bash
ssh -N -L 18080:127.0.0.1:18080 USER@SERVER
```

然后浏览器访问 `http://127.0.0.1:18080`。后台只在服务器回环地址监听，关闭 SSH 隧道不会停止机器人。逐项确认账号在线且“监听中”、商品规格绑定、API 卡券 URL 为内网网关地址、注册关闭，再用测试订单验证单份和多份发货。切换服务器 IP 可能触发闲鱼重新登录或人机验证。

## 运营人员配置提取码卡密

在“卡密库存”中新增 API 卡密，选择账号系统中的账号池，填写新卡密名称，设置买家首次提取账号后的有效时长，核对“发货说明（买家可见）”，保存后到商品发货设置中绑定新卡密。账号池列表由管家后端通过内网网关读取，该列表接口仅返回账号池 ID 和名称。接口地址、Bearer 密钥、订单号、商品号和多份发货序号会从当前用户已有的可信内网 API 卡密沿用，无需手写 JSON。

已有订单按账号池和有效时长固定取码；新时长或新账号池应创建并绑定新卡密。直接修改已使用卡密的时长可能导致旧订单重试返回冲突。首次接入时若当前用户没有配置可信内网 API 卡密，账号池列表会明确提示管理员先在“自定义 API / 高级配置”完成一次连接配置。

## 回滚与卸载

若服务器监听异常，先停止服务器应用，再恢复本机 `Start.py`。订单和发码记录应先核对，避免对同一订单重复发送。网关可继续运行用于排查；正式回滚时用本项目的 `docker compose ... down` 停止并移除应用和网关，不影响账号系统 Compose。确认不再需要且已保存备份后，删除 `${XIAN_YU_STATE_DIR}` 和闲鱼代码目录，即可清理管家数据；账号系统的网络、数据库和服务仍保持原样。
