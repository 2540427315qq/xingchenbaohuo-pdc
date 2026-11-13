# teleagent-dashboard — TeleAgent 云电脑保活/积分/电源管理控制台
# 容器内无 Windows 客户端 → 鉴权用 TA_TOKEN_FILE 挂载明文 JWT 文件
FROM node:20-alpine

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --registry=https://registry.npmmirror.com && npm cache clean --force
COPY server.js ./
COPY lib ./lib
COPY public ./public
COPY scripts ./scripts

ENV PORT=8590
# 容器内监听全部网卡，宿主机 docker port 映射才能访问（本机部署默认 127.0.0.1）
ENV TA_HOST=0.0.0.0
EXPOSE 8590
VOLUME ["/app/data"]

# 首次使用：把源机导出的 JWT（单行文本）挂到 /app/data/jwt.txt
#   TA_TOKEN_FILE=/app/data/jwt.txt
CMD ["node", "server.js"]
