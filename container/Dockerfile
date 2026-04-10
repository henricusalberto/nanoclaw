# NanoClaw Agent Container
# Runs Claude Agent SDK in isolated Linux VM with browser automation

FROM node:22-slim

# Install system dependencies for Chromium and PDF tools
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    libgbm1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libcups2 \
    libdrm2 \
    libxshmfence1 \
    curl \
    git \
    poppler-utils \
    python3 \
    python3-pip \
    python3-venv \
    yt-dlp \
    && rm -rf /var/lib/apt/lists/*

# Python packages used by OpenClaw workspace scripts (Fathom, finance, planning, etc.)
# Installed system-wide; the stub-venv overlay (see below) makes scripts that
# `source venv/bin/activate` transparently use this Python.
RUN pip3 install --break-system-packages --no-cache-dir \
    requests \
    python-docx \
    python-dateutil \
    lxml \
    beautifulsoup4 \
    pillow \
    openpyxl \
    cryptography \
    flask \
    google-api-python-client \
    google-auth \
    google-auth-oauthlib \
    google-auth-httplib2 \
    gspread \
    flask-cors \
    gunicorn \
    svix \
    browser-cookie3

# Stub venv for OpenClaw backwards compatibility.
# Cron prompts written for the Mac venv (`source venv/bin/activate && python3 ...`)
# get this directory bind-mounted over the Mac venv path at container runtime.
# The stub forwards to system Python (which has the packages above).
RUN mkdir -p /opt/nanoclaw/stub-venv/bin \
    && ln -s /usr/bin/python3 /opt/nanoclaw/stub-venv/bin/python \
    && ln -s /usr/bin/python3 /opt/nanoclaw/stub-venv/bin/python3 \
    && ln -s /usr/bin/pip3    /opt/nanoclaw/stub-venv/bin/pip \
    && ln -s /usr/bin/pip3    /opt/nanoclaw/stub-venv/bin/pip3 \
    && printf '# nanoclaw stub venv — no-op activate\nexport VIRTUAL_ENV=/opt/nanoclaw/stub-venv\nexport PATH="/opt/nanoclaw/stub-venv/bin:$PATH"\n' > /opt/nanoclaw/stub-venv/bin/activate \
    && chmod +x /opt/nanoclaw/stub-venv/bin/activate

# Set Chromium path for agent-browser
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Install agent-browser, claude-code, and QMD globally
RUN npm install -g agent-browser @anthropic-ai/claude-code @tobilu/qmd

# Create app directory
WORKDIR /app

# Copy package files first for better caching
COPY agent-runner/package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY agent-runner/ ./

# Build TypeScript
RUN npm run build

# Install pdf-reader CLI
COPY skills/pdf-reader/pdf-reader /usr/local/bin/pdf-reader
RUN chmod +x /usr/local/bin/pdf-reader

# Create workspace directories
RUN mkdir -p /workspace/group /workspace/global /workspace/extra /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input

# Create entrypoint script
# Container input (prompt, group info) is passed via stdin JSON.
# Credentials are injected by the host's credential proxy — never passed here.
# Follow-up messages arrive via IPC files in /workspace/ipc/input/
RUN printf '#!/bin/bash\nset -e\ncd /app && npx tsc --outDir /tmp/dist 2>&1 >&2\nln -s /app/node_modules /tmp/dist/node_modules\nchmod -R a-w /tmp/dist\ncat > /tmp/input.json\nnode /tmp/dist/index.js < /tmp/input.json\n' > /app/entrypoint.sh && chmod +x /app/entrypoint.sh

# Set ownership to node user (non-root) for writable directories
RUN chown -R node:node /workspace && chmod 777 /home/node

# Switch to non-root user (required for --dangerously-skip-permissions)
USER node

# Set working directory to group workspace
WORKDIR /workspace/group

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]
