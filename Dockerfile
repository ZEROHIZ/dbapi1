FROM node:lts AS BUILD_IMAGE

WORKDIR /app

COPY . /app

# Use the mirror registry to speed up dependency installation in CI.
RUN yarn install --registry https://registry.npmmirror.com/ --ignore-engines \
  && yarn run build

FROM node:lts-slim

# Install runtime basics only. Browser profile login is supported only when
# running directly in a Windows desktop session, not inside this Linux image.
RUN apt-get update && apt-get install -y --no-install-recommends \
  bash \
  ca-certificates \
  tzdata \
  && rm -rf /var/lib/apt/lists/*

ENV TZ=Asia/Shanghai

WORKDIR /app

COPY --from=BUILD_IMAGE /app/configs /app/configs
COPY --from=BUILD_IMAGE /app/package.json /app/package.json
COPY --from=BUILD_IMAGE /app/dist /app/dist
COPY --from=BUILD_IMAGE /app/public /app/public
COPY --from=BUILD_IMAGE /app/node_modules /app/node_modules
COPY --from=BUILD_IMAGE /app/scripts /app/scripts

RUN mkdir -p /app/data && chmod 777 /app/data

VOLUME ["/app/data"]

EXPOSE 8000

CMD ["npm", "start"]
