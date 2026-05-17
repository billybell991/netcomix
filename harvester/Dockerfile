FROM python:3.12-slim

WORKDIR /app

# Minimal deps for migration only (no opencv/google-api)
RUN pip install --no-cache-dir boto3 psycopg2-binary

COPY migrate.py db_pg.py ./

# Railway injects DATABASE_URL, R2_* env vars automatically
CMD ["python", "migrate.py"]
