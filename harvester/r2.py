"""
R2 upload helpers for the NetComix harvester.

Activated when these env vars are all present:
  R2_BUCKET            — bucket name
  R2_ENDPOINT_URL      — https://<account>.r2.cloudflarestorage.com
  R2_ACCESS_KEY_ID     — R2 API token (Access Key ID)
  R2_SECRET_ACCESS_KEY — R2 API token (Secret Access Key)
"""
from __future__ import annotations

import os
from pathlib import Path

_REQUIRED = ("R2_BUCKET", "R2_ENDPOINT_URL", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY")


def r2_configured() -> bool:
    return all(os.environ.get(v) for v in _REQUIRED)


def _client():
    import boto3
    return boto3.client(
        "s3",
        endpoint_url=os.environ["R2_ENDPOINT_URL"],
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        region_name="auto",
    )


def upload_jpeg(local_path: Path, r2_key: str) -> str:
    """Upload a JPEG file to R2. Returns the r2_key."""
    bucket = os.environ["R2_BUCKET"]
    _client().upload_file(
        str(local_path),
        bucket,
        r2_key,
        ExtraArgs={"ContentType": "image/jpeg", "CacheControl": "public, max-age=31536000"},
    )
    return r2_key


def upload_bytes(data: bytes, r2_key: str, content_type: str = "application/octet-stream") -> str:
    """Upload raw bytes to R2. Returns the r2_key."""
    import io
    bucket = os.environ["R2_BUCKET"]
    _client().put_object(
        Bucket=bucket,
        Key=r2_key,
        Body=io.BytesIO(data),
        ContentType=content_type,
        CacheControl="public, max-age=31536000",
    )
    return r2_key


def key_exists(r2_key: str) -> bool:
    """Return True if an object with this key already exists in R2."""
    import botocore.exceptions  # type: ignore
    bucket = os.environ["R2_BUCKET"]
    try:
        _client().head_object(Bucket=bucket, Key=r2_key)
        return True
    except botocore.exceptions.ClientError as e:
        if e.response["Error"]["Code"] in ("404", "NoSuchKey"):
            return False
        raise
