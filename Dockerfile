# Dockerfile — production image for server/server.js (ESM)
FROM node:18-alpine

# System deps: tini for proper signal handling (optional but nice)
RUN apk add --no-cache tini

WORKDIR /app

# Install only what package.json needs
COPY package*.json ./
# Use CI install for reproducibility; omit dev deps in prod
RUN npm ci --omit=dev

# Copy the rest of the project
COPY . .

# Environment (can be overridden by Fly)
ENV NODE_ENV=production

# The app will listen on process.env.PORT (Fly sets this). We default to 8080.
EXPOSE 8080

# Use tini as init to handle signals gracefully
ENTRYPOINT ["/sbin/tini", "--"]

# Start the server; your package.json should have "start": "node server/server.js"
CMD ["npm", "start"]
