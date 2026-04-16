FROM node:20
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV PORT=10000
EXPOSE 10000
CMD ["node", "start.js"]
