FROM node:22

WORKDIR /app

COPY package.json /app/package.json
RUN npm install --production

COPY main.js /app/main.js
COPY AGENT.md /app/AGENT.md

CMD ["node", "main.js"]
