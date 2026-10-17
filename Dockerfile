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

# ---------- 2) backend: runs natively on the build host; the jar is arch-independent ----------
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

# ---------- 3) runtime: one per target arch; NO RUN steps, so arm64 needs no emulation ----------
FROM eclipse-temurin:21-jre-noble
ARG GIT_SHA=dev
WORKDIR /app
COPY --from=backend /extracted/dependencies/ ./
COPY --from=backend /extracted/spring-boot-loader/ ./
COPY --from=backend /extracted/snapshot-dependencies/ ./
COPY --from=backend /extracted/application/ ./
COPY --from=backend --chown=1000:1000 /out/data /data
ENV NOTES_VAULT_DIR=/data/vault \
    NOTES_BUILD_SHA=${GIT_SHA} \
    XDG_CONFIG_HOME=/data/.config \
    GIT_CONFIG_NOSYSTEM=1 \
    SERVER_ADDRESS=127.0.0.1 \
    JAVA_TOOL_OPTIONS="-XX:MaxRAMPercentage=75.0 -XX:+ExitOnOutOfMemoryError"
# uid/gid 1000 = the 'ubuntu' user that ships in the noble base image (no useradd needed); see DESIGN §7.7 for why 1000
USER 1000:1000
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/readyz || exit 1
ENTRYPOINT ["java", "-jar", "application.jar"]
