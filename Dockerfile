# Dockerfile — production image for server/server.js (ESM)
FROM node:18-alpine

# tini for proper signal handling (now with subreaper enabled)
RUN apk add --no-cache tini

WORKDIR /app

# Install only dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy the rest of the project
COPY . .

ENV NODE_ENV=production
# App listens on PORT, default 8080
EXPOSE 8080

# Run tini as PID 1, with -s (subreaper) to avoid the dashboard warning
ENTRYPOINT ["/sbin/tini", "-s", "--"]
CMD ["npm", "start"]
