# teleagent-dashboard — TeleAgent 云电脑保活/积分/电源管理控制台
# 鉴权用页面「账号登录」（JWT 自动落盘 data/jwt.txt 并自动续期）
FROM node:20-alpine

# 时区：装 tzdata 并设 TZ，保证日志/定时任务（领取时间、重启计划）按北京时间走
RUN apk add --no-cache tzdata
ENV TZ=Asia/Shanghai

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --registry=https://registry.npmmirror.com && npm cache clean --force
COPY server.js ./
COPY lib ./lib
COPY public ./public

ENV PORT=8590
# 容器内监听全部网卡，宿主机 docker port 映射才能访问（本机部署默认 127.0.0.1）
ENV TA_HOST=0.0.0.0
EXPOSE 8590
VOLUME ["/app/data"]

CMD ["node", "server.js"]
