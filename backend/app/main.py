from __future__ import annotations

import os
import re
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlsplit, urlunsplit
from uuid import uuid4

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv
from pydantic import BaseModel, Field, HttpUrl, field_validator
from pymongo import ASCENDING, DESCENDING, MongoClient

load_dotenv(Path(__file__).resolve().parents[1] / ".env")

EMAIL_PATTERN = re.compile(r"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}", re.IGNORECASE)
PHONE_PATTERN = re.compile(r"\b(?:\+?\d[\d\s().-]{7,}\d)\b")
KEY_PATTERN = re.compile(r"\b(?:sk|pk|api|key)[-_]?[A-Za-z0-9_-]{16,}\b", re.IGNORECASE)


def redact_sensitive_text(value: str) -> str:
    return KEY_PATTERN.sub("[key-like value masked]", PHONE_PATTERN.sub("[number masked]", EMAIL_PATTERN.sub("[email masked]", value)))


class Finding(BaseModel):
    finding_id: str
    scenario_id: int = Field(ge=1, le=11)
    scenario_name: str = Field(max_length=100)
    category: str = Field(max_length=100)
    severity: Literal["informational", "low", "medium", "high", "critical"]
    confidence: float = Field(ge=0, le=1)
    confidence_rationale: str = Field(max_length=500)
    title: str = Field(max_length=200)
    summary: str = Field(max_length=1000)
    evidence: list[str] = Field(max_length=20)
    affected_element_description: str = Field(max_length=300)
    page_url: str = Field(max_length=2048)
    detected_at: datetime
    recommended_action: str = Field(max_length=1000)
    limitations: str = Field(max_length=1000)
    verification_status: Literal["observed", "inferred", "verified", "inconclusive"]

    @field_validator("page_url", mode="before")
    @classmethod
    def redact_page_url(cls, value: Any) -> Any:
        if not isinstance(value, str):
            return value
        parts = urlsplit(str(value))
        return urlunsplit((parts.scheme, parts.netloc.rsplit("@", 1)[-1], parts.path, "", ""))

    @field_validator("evidence", mode="before")
    @classmethod
    def redact_evidence(cls, value: Any) -> Any:
        if not isinstance(value, list):
            return value
        return [redact_sensitive_text(str(item))[:200] for item in value]


class ScanCreate(BaseModel):
    url: HttpUrl
    title: str = Field(max_length=300)
    scanned_at: datetime
    findings: list[Finding] = Field(max_length=200)

    @field_validator("url", mode="before")
    @classmethod
    def redact_scan_url(cls, value: Any) -> Any:
        if not isinstance(value, str):
            return value
        parts = urlsplit(str(value))
        return urlunsplit((parts.scheme, parts.netloc.rsplit("@", 1)[-1], parts.path, "", ""))

    @field_validator("title", mode="before")
    @classmethod
    def redact_title(cls, value: Any) -> Any:
        if not isinstance(value, str):
            return value
        return redact_sensitive_text(str(value))[:300]


class SettingsPatch(BaseModel):
    retention_days: int | None = Field(default=None, ge=1, le=365)
    keep_history: bool | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    uri = os.getenv("MONGODB_URI")
    app.state.mongo = None
    if uri:
        client = MongoClient(uri, serverSelectionTimeoutMS=1500)
        client.admin.command("ping")
        app.state.mongo = client
        db = client[os.getenv("MONGODB_DATABASE", "taif")]
        db.scans.create_index([("created_at", DESCENDING)])
        db.scans.create_index([("scan_id", ASCENDING)], unique=True)
        db.settings.create_index([("user_key", ASCENDING)], unique=True)
    yield
    if app.state.mongo:
        app.state.mongo.close()


app = FastAPI(title="TAIF Local API", version="1.0.0", lifespan=lifespan)
origins = [origin.strip() for origin in os.getenv("ALLOWED_ORIGINS", "http://localhost:5173").split(",") if origin.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "PATCH"],
    allow_headers=["Content-Type"],
)


def scans_collection():
    client = app.state.mongo
    if client is None:
        raise HTTPException(status_code=503, detail="MongoDB is not configured; local extension scanning remains available.")
    return client[os.getenv("MONGODB_DATABASE", "taif")].scans


@app.get("/api/v1/health")
def health():
    return {"status": "ok", "database": "connected" if app.state.mongo else "not_configured"}


@app.post("/api/v1/scans", status_code=201)
def create_scan(scan: ScanCreate):
    scan_id = str(uuid4())
    document = scan.model_dump(mode="json")
    document.update({"scan_id": scan_id, "created_at": datetime.now(timezone.utc).isoformat()})
    scans_collection().insert_one(document)
    return {"scan_id": scan_id}


@app.get("/api/v1/scans")
def list_scans(limit: int = Query(20, ge=1, le=100), offset: int = Query(0, ge=0)):
    items = list(scans_collection().find({}, {"_id": 0}).sort("created_at", DESCENDING).skip(offset).limit(limit))
    return {"items": items, "limit": limit, "offset": offset}


@app.get("/api/v1/scans/{scan_id}")
def get_scan(scan_id: str):
    scan = scans_collection().find_one({"scan_id": scan_id}, {"_id": 0})
    if scan is None:
        raise HTTPException(status_code=404, detail="Scan not found.")
    return scan


@app.get("/api/v1/findings/{finding_id}")
def get_finding(finding_id: str):
    scan = scans_collection().find_one({"findings.finding_id": finding_id}, {"_id": 0})
    if scan is None:
        raise HTTPException(status_code=404, detail="Finding not found.")
    return next(item for item in scan["findings"] if item["finding_id"] == finding_id)


@app.get("/api/v1/settings")
def get_settings():
    client = app.state.mongo
    if client is None:
        return {"retention_days": 30, "keep_history": False, "storage": "local_only"}
    value = client[os.getenv("MONGODB_DATABASE", "taif")].settings.find_one({"user_key": "local-default"}, {"_id": 0})
    return value or {"retention_days": 30, "keep_history": False}


@app.patch("/api/v1/settings")
def patch_settings(settings: SettingsPatch):
    client = app.state.mongo
    if client is None:
        raise HTTPException(status_code=503, detail="MongoDB is not configured.")
    updates: dict[str, Any] = settings.model_dump(exclude_none=True)
    client[os.getenv("MONGODB_DATABASE", "taif")].settings.update_one(
        {"user_key": "local-default"}, {"$set": updates, "$setOnInsert": {"user_key": "local-default"}}, upsert=True
    )
    return get_settings()
