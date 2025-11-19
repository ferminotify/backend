# Fermi Notify Backend - Dockerfile
# Uses Node.js 20 LTS on Alpine for a small image
FROM node:20-alpine

# Create app directory
WORKDIR /app

# Install dependencies first (better layer caching)
COPY package.json ./
# If you later add a lockfile, prefer: npm ci --omit=dev
RUN npm install --omit=dev

# Bundle app source
COPY . .

# Set environment
ENV NODE_ENV=production

# Expose API port
EXPOSE 3001

# Start the server
CMD ["node", "server.js"]
