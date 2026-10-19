# 与仓库根目录 Dockerfile 保持一致；云托管默认使用根目录文件。
FROM node:20-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    python3-pip \
    python3-venv \
    libgomp1 \
    ca-certificates \
    curl \
  && rm -rf /var/lib/apt/lists/* \
  && curl -fsSL --retry 5 --retry-all-errors --retry-delay 3 -o /tmp/llama.tar.gz \
    https://github.com/ggml-org/llama.cpp/releases/download/b11555/llama-b11555-bin-ubuntu-x64.tar.gz \
  && mkdir -p /tmp/llama \
  && tar -xzf /tmp/llama.tar.gz -C /tmp/llama \
  && cli=$(find /tmp/llama -type f -name llama-cli | head -n 1) \
  && test -n "$cli" \
  && install -m 755 "$cli" /usr/local/bin/llama-cli \
  && rm -rf /tmp/llama /tmp/llama.tar.gz
WORKDIR /app
COPY scripts/video-ingest/package.json scripts/video-ingest/package-lock.json ./
RUN npm ci --omit=dev
COPY scripts/video-ingest/requirements-asr.txt ./
RUN python3 -m venv /opt/asr \
  && /opt/asr/bin/pip install --upgrade pip \
  && /opt/asr/bin/pip install --no-cache-dir -r requirements-asr.txt
ENV VIDEO_INGEST_PYTHON=/opt/asr/bin/python
ENV VIDEO_INGEST_ASR_MODEL=small
ENV VIDEO_INGEST_LLAMA=/usr/local/bin/llama-cli
ENV VIDEO_INGEST_SUMMARY_MODEL=/opt/summary/Qwen_Qwen3-4B-Instruct-2507-Q4_K_M.gguf
ENV VIDEO_INGEST_SUMMARY_WAIT=1
ENV HF_HOME=/opt/asr-cache
ENV HUGGINGFACE_HUB_CACHE=/opt/asr-cache
ENV HF_HUB_DISABLE_TELEMETRY=1
# 镜像站走普通 HTTPS；hf-xet 会打到 cas-server.xethub.hf.co 并 401。
ENV HF_HUB_DISABLE_XET=1
ENV HF_HUB_ENABLE_HF_TRANSFER=0
ARG HF_ENDPOINT=https://hf-mirror.com
ENV HF_ENDPOINT=${HF_ENDPOINT}
# 只预拉转写模型。摘要权重约 2.5GB，放进镜像后个人版仓库推不完。
RUN /opt/asr/bin/pip uninstall -y hf-xet \
  && /opt/asr/bin/python -c "from faster_whisper import WhisperModel; WhisperModel('small', device='cpu', compute_type='int8')"
# llama-cli 会按所在目录加载 libllama-cli-impl.so；只安装可执行文件会在启动时退出。
RUN curl -fsSL --retry 5 --retry-all-errors --retry-delay 3 -o /tmp/llama.tar.gz \
    https://github.com/ggml-org/llama.cpp/releases/download/b11555/llama-b11555-bin-ubuntu-x64.tar.gz \
  && mkdir -p /tmp/llama /usr/local/lib \
  && tar -xzf /tmp/llama.tar.gz -C /tmp/llama \
  && find /tmp/llama \( -type f -o -type l \) -name 'lib*.so*' -exec cp -L {} /usr/local/bin/ \; \
  && find /tmp/llama \( -type f -o -type l \) -name 'lib*.so*' -exec cp -L {} /usr/local/lib/ \; \
  && test -e /usr/local/bin/libllama-cli-impl.so \
  && ldconfig \
  && if ldd /usr/local/bin/llama-cli | grep -q 'not found'; then exit 1; fi \
  && rm -rf /tmp/llama /tmp/llama.tar.gz
ENV LD_LIBRARY_PATH=/usr/local/lib:/usr/local/bin
COPY scripts/video-ingest ./
ENV PORT=80
EXPOSE 80
CMD ["node", "cloudRunServer.js"]
