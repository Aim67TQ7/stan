FROM node:22

WORKDIR /app

# Install OpenClaw CLI globally
RUN npm install -g openclaw@latest

# Copy orchestrator config and source
COPY openclaw.json /root/.openclaw/openclaw.json
COPY index.js /app/index.js
COPY package.json /app/package.json

RUN npm install --production

EXPOSE 18789

CMD ["node", "index.js"]
