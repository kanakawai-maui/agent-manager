# Use Node.js LTS
FROM node:20-slim

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install ALL dependencies (including devDependencies for build)
RUN npm ci

# Copy source code
COPY . .

# Build TypeScript
RUN npm run build

# Debug: List the dist directory to verify files
RUN echo "=== Files in dist/ ===" && ls -la dist/ && echo "=== Files in dist root ===" && ls -la dist/*.js || true

# Remove devDependencies to reduce image size
RUN npm prune --production

# Expose port
EXPOSE 3001

# Start the web server
CMD ["node", "dist/web-server.js", "--port", "3001"]
