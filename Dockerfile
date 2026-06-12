# Use Node.js LTS
FROM node:20-slim

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# Install ALL dependencies (including devDependencies for build)
RUN npm ci

# Copy source code (but not build artifacts)
COPY src ./src
COPY public ./public
COPY provider-configs.example.json ./

# Clean build
RUN rm -rf dist .tsbuildinfo

# Build TypeScript
RUN npm run build

# Debug: List the dist directory to verify files
RUN echo "=== Files in dist/ ===" && ls -laR dist/

# Remove devDependencies to reduce image size
RUN npm prune --production

# Expose port
EXPOSE 3001

# Start the web server
CMD ["node", "dist/web-server.js", "--port", "3001"]
