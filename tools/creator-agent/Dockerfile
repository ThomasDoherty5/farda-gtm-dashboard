# API-only image. TLS termination and the persistent volume belong to the deployment environment.
FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY src/creator-agent/ ./src/creator-agent/
COPY src/features/scorecards/scorecardMath.ts ./src/features/scorecards/scorecardMath.ts
COPY tools/creator-agent/*.mjs ./tools/creator-agent/
RUN mkdir -p /var/lib/farda-agent && chown node:node /var/lib/farda-agent && chmod 700 /var/lib/farda-agent
ENV FARDA_AGENT_DATABASE=/var/lib/farda-agent/evidence.sqlite
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["node", "tools/creator-agent/healthcheck.mjs"]
CMD ["node", "tools/creator-agent/run.mjs"]
