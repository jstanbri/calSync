ARG N8N_VERSION=2.48.8
FROM n8nio/n8n:${N8N_VERSION}
USER root
RUN mkdir -p /opt/calsync && cd /opt/calsync && npm init -y >/dev/null && npm install ical.js@2.1.0 && chown -R node:node /opt/calsync
USER node
ENV NODE_PATH=/opt/calsync/node_modules
ENV NODE_FUNCTION_ALLOW_EXTERNAL=ical.js
