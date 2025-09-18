# Multi-architecture build:
# docker buildx build --platform linux/amd64,linux/arm64 --no-cache -t cronicle:bundle -f Dockerfile .
#
# Single architecture builds:
# docker build --no-cache -t cronicle:bundle -f Dockerfile .
# docker tag cronicle:bundle cronicle/cronicle:edge
#
# Test run: docker run --rm -it -p 3019:3012 -e CRONICLE_manager=1 cronicle:bundle bash
# then type manager or worker

# cronicle/base-alpine: 
# FROM alpine:3.19.1
# RUN apk add --no-cache bash nodejs tini util-linux bash openssl procps coreutils curl tar jq


# FROM cronicle/base-alpine AS build

FROM node:20-slim

# Set up architecture variables
ARG TARGETPLATFORM
ARG BUILDPLATFORM
RUN echo "Building for $TARGETPLATFORM on $BUILDPLATFORM"

RUN apt update \
  && apt-get install -y gnupg less git curl ca-certificates apt-transport-https build-essential vim bash \
  net-tools iputils-ping xz-utils sudo zip unzip bzip2 python3 python3-pip python3-boto3  sendemail mailutils libnet-ssleay-perl \
  libio-socket-ssl-perl jq tzdata gettext tini mandoc

RUN ln -s /usr/bin/python3 /usr/bin/python

# Install AWS CLI with architecture detection
RUN case "${TARGETPLATFORM}" in \
  "linux/amd64") AWSARCH="x86_64" ;; \
  "linux/arm64") AWSARCH="aarch64" ;; \
  *) echo "Unsupported platform: ${TARGETPLATFORM}" && exit 1 ;; \
  esac \
  && curl "https://awscli.amazonaws.com/awscli-exe-linux-${AWSARCH}.zip" -o "awscliv2.zip" \
  && unzip awscliv2.zip \
  && ./aws/install \
  && rm -rf awscliv2.zip aws

# Install MongoDB database tools with architecture detection
RUN case "${TARGETPLATFORM}" in \
  "linux/amd64") MONGOARCH="x86_64" ;; \
  "linux/arm64") MONGOARCH="arm64" ;; \
  *) echo "Unsupported platform: ${TARGETPLATFORM}" && exit 1 ;; \
  esac \
  && curl https://fastdl.mongodb.org/tools/db/mongodb-database-tools-ubuntu2204-${MONGOARCH}-100.11.0.deb -o mongodb-database-tools-100.11.0.deb \
  && dpkg -i mongodb-database-tools-100.11.0.deb && rm mongodb-database-tools-100.11.0.deb

# Install MongoDB shell with architecture detection
RUN case "${TARGETPLATFORM}" in \
  "linux/amd64") MONGOSHARCH="amd64" ;; \
  "linux/arm64") MONGOSHARCH="arm64" ;; \
  *) echo "Unsupported platform: ${TARGETPLATFORM}" && exit 1 ;; \
  esac \
  && curl https://downloads.mongodb.com/compass/mongodb-mongosh_2.4.2_${MONGOSHARCH}.deb -o mongodb-mongosh_2.4.2_${MONGOSHARCH}.deb \
  && dpkg -i mongodb-mongosh_2.4.2_${MONGOSHARCH}.deb && rm mongodb-mongosh_2.4.2_${MONGOSHARCH}.deb

RUN npm i -g typescript tsx sst@2 node-gyp pm2 ts-node


COPY . /opt/build
WORKDIR /opt/build

RUN rm -rf node_modules \
  && npm i \
  && ./bundle /opt/cronicle --s3 --tools

# non root user for shell plugin
ARG CRONICLE_UID=2000
ARG CRONICLE_GID=2099
RUN groupadd --gid $CRONICLE_GID cronicle || true \
  && if id -u $CRONICLE_UID >/dev/null 2>&1; then \
       userdel $(id -nu $CRONICLE_UID); \
     fi \
  && useradd --uid $CRONICLE_UID --gid $CRONICLE_GID --home-dir /opt/cronicle --create-home --shell /bin/bash cronicle

# COPY --from=build /dist /opt/cronicle

ENV PATH="/opt/cronicle/bin:${PATH}"
ENV CRONICLE_foreground=1
ENV CRONICLE_echo=1
ENV TZ=America/Chicago 

WORKDIR /opt/cronicle 

# protect sensitive folders
RUN  mkdir -p /opt/cronicle/data /opt/cronicle/conf && chmod 0700 /opt/cronicle/data /opt/cronicle/conf

ENTRYPOINT ["/usr/bin/tini", "--"]
