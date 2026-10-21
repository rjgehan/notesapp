# syntax=docker/dockerfile:1

# ---------- 1) frontend: runs natively on the build host ($BUILDPLATFORM); output is arch-independent ----------
FROM --platform=$BUILDPLATFORM node:24-bookworm-slim AS frontend
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
ARG GIT_SHA=dev
ENV VITE_BUILD_SHA=${GIT_SHA}
RUN npm run build

# ---------- 2) backend: runs natively on the build host; the jar is arch-independent (bytecode for Java 21) ----------
FROM --platform=$BUILDPLATFORM eclipse-temurin:21-jdk-noble AS backend
WORKDIR /src/backend
COPY backend/.mvn/ .mvn/
COPY backend/mvnw backend/pom.xml ./
RUN sh ./mvnw -B -ntp -q dependency:go-offline || true
COPY backend/src/ src/
COPY --from=frontend /src/frontend/dist/ src/main/resources/static/
RUN sh ./mvnw -B -ntp -DskipTests package \
 && cp target/notesapp-*.jar /tmp/application.jar \
 && java -Djarmode=tools -jar /tmp/application.jar extract --layers --destination /extracted \
 && mkdir -p /out/data/vault /out/data/.config

# ---------- 3) Claude Code CLI for Ask your vault (ROADMAP item 18, DESIGN §5.20): Anthropic's native binary for the
# target arch, downloaded on the build host (no emulation) from the official release bucket and checked against the
# release manifest's SHA-256. About 290 MB per arch (about 100 MB compressed). Claude Code is Anthropic's proprietary
# software ("all rights reserved"): an image that contains it is for your own use, so keep the GHCR package private
# (DEPLOY.md, "Ask your vault"), or build with --build-arg CLAUDE_CODE_VERSION=none and mount the CLI instead.
FROM --platform=$BUILDPLATFORM debian:bookworm-slim AS claude-code
ARG TARGETARCH
ARG CLAUDE_CODE_VERSION=2.1.304
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl jq \
 && rm -rf /var/lib/apt/lists/*
RUN set -eu; mkdir -p /out/bin; \
    if [ "$CLAUDE_CODE_VERSION" = "none" ]; then echo "building without Claude Code"; exit 0; fi; \
    case "$TARGETARCH" in amd64) p=linux-x64 ;; arm64) p=linux-arm64 ;; *) echo "no Claude Code for $TARGETARCH" >&2; exit 1 ;; esac; \
    base="https://downloads.claude.ai/claude-code-releases/$CLAUDE_CODE_VERSION"; \
    sum="$(curl -fsSL "$base/manifest.json" | jq -r ".platforms[\"$p\"].checksum")"; \
    echo "$sum" | grep -Eq '^[0-9a-f]{64}$'; \
    curl -fsSL -o /out/bin/claude "$base/$p/claude"; \
    echo "$sum  /out/bin/claude" | sha256sum -c -; \
    chmod 755 /out/bin/claude

# ---------- 4) runtime: one per target arch, on JDK 25. Its two RUN steps run under QEMU for arm64 (DESIGN §7.1) ----------
FROM eclipse-temurin:25-jre-noble
ARG GIT_SHA=dev
ARG TARGETARCH
ARG BUILDARCH
# The JDK 25 images ship without curl, which the HEALTHCHECK below and DEPLOY.md's restore drill use.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=backend /extracted/dependencies/ ./
COPY --from=backend /extracted/spring-boot-loader/ ./
COPY --from=backend /extracted/snapshot-dependencies/ ./
COPY --from=backend /extracted/application/ ./
COPY --from=backend --chown=1000:1000 /out/data /data
COPY --from=claude-code /out/bin/ /opt/claude/bin/
ENV NOTES_VAULT_DIR=/data/vault \
    NOTES_AI_CLAUDE_COMMAND=/opt/claude/bin/claude \
    NOTES_BUILD_SHA=${GIT_SHA} \
    XDG_CONFIG_HOME=/data/.config \
    GIT_CONFIG_NOSYSTEM=1 \
    SERVER_ADDRESS=127.0.0.1 \
    JAVA_TOOL_OPTIONS="-XX:MaxRAMPercentage=75.0 -XX:+ExitOnOutOfMemoryError"
# AOT cache (JEP 483/514): a training run starts the app on a scratch vault and stops once the Spring context is
# refreshed, before anything listens; the JVM then writes the classes it loaded and linked, with their profiles, to
# notesapp.aot, which the ENTRYPOINT uses. It runs here because the cache only fits this JVM build, this architecture
# and these exact jars. Natively a failed training run fails the build; under emulation the image ships without the
# cache (the JVM then starts normally, and the status page shows "AOT cache: not used").
RUN set -eu; \
    t=/tmp/aot-training; mkdir -p "$t"; \
    if XDG_CONFIG_HOME="$t/config" timeout 900 java -XX:AOTCacheOutput=/app/notesapp.aot \
         -Dspring.context.exit=onRefresh -Djava.io.tmpdir="$t" -jar application.jar \
         --notes.vault-dir="$t/vault" --notes.allowed-hosts=localhost \
         --notes.security.require-tailscale-interface=false \
       && [ -s /app/notesapp.aot ]; then \
      ls -l /app/notesapp.aot; \
    elif [ "$TARGETARCH" = "$BUILDARCH" ]; then \
      echo "ERROR: the AOT cache training run failed" >&2; exit 1; \
    else \
      echo "WARNING: the AOT cache training run failed under emulation ($TARGETARCH on $BUILDARCH);" \
           "this image starts without the cache" >&2; \
      rm -f /app/notesapp.aot; \
    fi; \
    rm -rf "$t" /app/notesapp.aot.config /tmp/hsperfdata_*
# uid/gid 1000 = the 'ubuntu' user that ships in the noble base image (no useradd needed); see DESIGN §7.7 for why 1000
USER 1000:1000
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/readyz || exit 1
ENTRYPOINT ["java", "-XX:AOTCache=/app/notesapp.aot", "-jar", "application.jar"]
