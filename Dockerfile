FROM node:22-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY public ./public
COPY src ./src

ENV NODE_ENV=production
ENV DATA_DIR=/data
ENV HTTP_PORT=33301
ENV DEVICE_MQTT_PORT=8885

EXPOSE 33301 8885 6002

CMD ["node", "src/index.js"]
