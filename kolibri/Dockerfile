FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 KOLIBRI_CONFIG_DIR=/app/config
WORKDIR /app
COPY pyproject.toml ./
COPY src ./src
RUN pip install --no-cache-dir ".[live]" && useradd -r -u 10001 kolibri && mkdir -p /app/data && chown kolibri /app/data
COPY config ./config
USER kolibri
CMD ["kolibri", "run"]
