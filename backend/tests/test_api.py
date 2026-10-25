import asyncio
from datetime import datetime, timezone

import httpx

from app.main import Finding, ScanCreate, app


def request(method, path, **kwargs):
    async def send():
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app),
                base_url="http://test",
            ) as client:
                return await client.request(method, path, **kwargs)

    return asyncio.run(send())


def test_health_reports_local_only_when_database_is_not_configured(monkeypatch):
    monkeypatch.delenv("MONGODB_URI", raising=False)
    response = request("GET", "/api/v1/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "database": "not_configured"}


def test_persistent_endpoints_fail_explicitly_without_mongodb(monkeypatch):
    monkeypatch.delenv("MONGODB_URI", raising=False)
    response = request("GET", "/api/v1/scans")
    assert response.status_code == 503
    assert "MongoDB is not configured" in response.json()["detail"]


def test_scan_and_finding_urls_drop_credentials_query_and_fragment():
    scan = ScanCreate(
        url="https://user:secret@example.test/product?session=private#details",
        title="Example product",
        scanned_at=datetime.now(timezone.utc),
        findings=[
            Finding(
                finding_id="s4-scarcity",
                scenario_id=4,
                scenario_name="Scarcity claims",
                category="Scarcity claims",
                severity="low",
                confidence=0.5,
                confidence_rationale="This claim is unverified.",
                title="Scarcity claim observed",
                summary="A visible claim cannot be verified.",
                evidence=["Only 2 items left. Contact person@example.test."],
                affected_element_description="paragraph element",
                page_url="https://user:secret@example.test/product?session=private#details",
                detected_at=datetime.now(timezone.utc),
                recommended_action="Check an authorized inventory source.",
                limitations="Page text cannot establish actual inventory.",
                verification_status="inconclusive",
            )
        ],
    )
    assert str(scan.url) == "https://example.test/product"
    assert scan.findings[0].page_url == "https://example.test/product"
    assert scan.findings[0].evidence == ["Only 2 items left. Contact [email masked]."]
