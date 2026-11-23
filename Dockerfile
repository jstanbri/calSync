FROM n8nio/n8n
USER root
RUN cd /usr/local/lib/node_modules/n8n && npm install ical.js@2.1.0
USER node

