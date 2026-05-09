FROM node:lts AS BUILD_IMAGE

WORKDIR /app

COPY . /app

# Use the mirror registry to speed up dependency installation in CI.
RUN yarn install --registry https://registry.npmmirror.com/ --ignore-engines \
  && yarn run build

FROM node:lts-slim

ARG FINGERPRINT_CHROMIUM_VERSION=latest

# Install timezone data, browser runtime dependencies, and download tools.
RUN apt-get update && apt-get install -y --no-install-recommends \
  bash \
  ca-certificates \
  curl \
  fonts-liberation \
  fonts-noto-cjk \
  findutils \
  libasound2 \
  libatk-bridge2.0-0 \
  libatk1.0-0 \
  libc6 \
  libcairo2 \
  libcups2 \
  libdbus-1-3 \
  libexpat1 \
  libfontconfig1 \
  libgbm1 \
  libgcc-s1 \
  libglib2.0-0 \
  libgtk-3-0 \
  libnspr4 \
  libnss3 \
  libpango-1.0-0 \
  libpangocairo-1.0-0 \
  libstdc++6 \
  libx11-6 \
  libx11-xcb1 \
  libxcb1 \
  libxcomposite1 \
  libxcursor1 \
  libxdamage1 \
  libxext6 \
  libxfixes3 \
  libxi6 \
  libxrandr2 \
  libxrender1 \
  libxshmfence1 \
  libxss1 \
  libxtst6 \
  tar \
  tzdata \
  xdg-utils \
  xz-utils \
  && rm -rf /var/lib/apt/lists/*

ENV TZ=Asia/Shanghai

WORKDIR /app

COPY --from=BUILD_IMAGE /app/configs /app/configs
COPY --from=BUILD_IMAGE /app/package.json /app/package.json
COPY --from=BUILD_IMAGE /app/dist /app/dist
COPY --from=BUILD_IMAGE /app/public /app/public
COPY --from=BUILD_IMAGE /app/node_modules /app/node_modules
COPY --from=BUILD_IMAGE /app/scripts /app/scripts

# Download the Linux fingerprint-chromium build at image build time and expose
# a stable executable path for the app.
RUN bash /app/scripts/setup-fingerprint-chromium.sh "$FINGERPRINT_CHROMIUM_VERSION" ".cache/fingerprint-chromium" \
  && ln -sf "$(find /app/.cache/fingerprint-chromium -type f \( -name chrome -o -name ungoogled-chromium \) | head -n 1)" /usr/local/bin/fingerprint-chromium

ENV FINGERPRINT_CHROMIUM_PATH=/usr/local/bin/fingerprint-chromium

RUN mkdir -p /app/data && chmod 777 /app/data

VOLUME ["/app/data"]

EXPOSE 8000

CMD ["npm", "start"]
