import asyncio

import httpx
import pytest
import vibedeck_server as server
from fastapi import HTTPException
from fastapi.testclient import TestClient
from workspace import create_library, read_workspace


def mock_pages(monkeypatch, pages, status=200, details=None):
    requests = []
    page_requests = []

    async def get(self, url, *, params, headers):
        requests.append((url, params.copy(), headers.copy()))
        if url.startswith("https://api.mistral.ai/v1/connectors/"):
            data = details[url.rsplit("/", 1)[1]]
        else:
            page_requests.append(url)
            data = pages[min(len(page_requests) - 1, len(pages) - 1)]
        return httpx.Response(status, json=data,
                              request=httpx.Request("GET", url))
    monkeypatch.setattr(httpx.AsyncClient, "get", get)
    return requests


@pytest.mark.asyncio
async def test_connectors_list_only_active_and_strip_credentials(monkeypatch):
    row = {"id": "one", "name": "private-connector", "title": "My connector", "active": True,
           "is_authenticated": False, "connection_credentials": [{"token": "secret"}], "server": "https://secret"}
    calls = mock_pages(monkeypatch, [
        {"items": [row, {**row, "id": "disabled", "active": False},
                   {**row, "id": "expired", "is_authenticated": False},
                   {**row, "id": "internal-library", "name": "document_library", "owner_type": "system"}],
         "pagination": {"next_cursor": "next"}},
        {"items": [row, {**row, "id": "two", "is_authenticated": None}], "pagination": {"next_cursor": None}},
    ], details={"one": {**row, "is_authenticated": True, "credentials": {"token": "detail-secret"}},
                "two": {**row, "id": "two", "name": "gmail", "title": None, "is_authenticated": True},
                "expired": {**row, "id": "expired"}})
    result = await read_workspace("connectors", "test-key")
    assert result["items"] == [
        {"id": "one", "name": "My connector", "description": "", "connected": True},
        {"id": "two", "name": "My connector", "description": "", "connected": True},
    ]
    assert calls[0][0] == "https://api.mistral.ai/v1/connectors"
    assert calls[0][1] == {"page_size": "100", "active": "true"}
    lists = [call for call in calls if call[0] == "https://api.mistral.ai/v1/connectors"]
    assert lists[1][1]["cursor"] == "next"
    details = [call for call in calls if call not in lists]
    assert len(details) == 3
    assert all(call[1] == {"fetch_user_data": "true", "fetch_customer_data": "false"} for call in details)
    assert calls[0][2]["Authorization"] == "Bearer test-key"
    assert "secret" not in str(result)


@pytest.mark.asyncio
async def test_system_service_names_and_changed_connection_state(monkeypatch):
    names = {"gmail": "Gmail", "github_app": "GitHub", "outlook": "Outlook",
             "google_calendar": "Google Calendar", "google_drive_mcp": "Google Drive"}
    rows = [{"id": name, "name": name, "active": True, "is_authenticated": False} for name in names]
    rows.append({"id": "changed", "name": "Changed", "active": True})
    details = {row["id"]: {**row, "is_authenticated": True} for row in rows}
    details["changed"]["active"] = False
    mock_pages(monkeypatch, [{"items": rows}], details=details)
    result = await read_workspace("connectors", "test-key")
    assert [item["name"] for item in result["items"]] == list(names.values())


@pytest.mark.asyncio
async def test_status_checks_are_concurrent_and_bounded(monkeypatch):
    rows = [{"id": str(i), "name": f"Service {i}", "active": True} for i in range(8)]
    running = peak = calls = 0

    async def get(self, url, **kwargs):
        nonlocal running, peak, calls
        if url == "https://api.mistral.ai/v1/connectors":
            data = {"items": rows}
        else:
            calls += 1
            running += 1
            peak = max(peak, running)
            await asyncio.sleep(.005)
            running -= 1
            data = {"id": url.rsplit("/", 1)[1], "active": True, "is_authenticated": True}
        return httpx.Response(200, json=data, request=httpx.Request("GET", url))
    monkeypatch.setattr(httpx.AsyncClient, "get", get)
    result = await read_workspace("connectors", "test-key")
    assert len(result["items"]) == calls == 8
    assert 1 < peak <= 4


@pytest.mark.asyncio
@pytest.mark.parametrize("status,body,expected", [
    (401, {"detail": "detail-secret"}, 403),
    (403, {"detail": "detail-secret"}, 403),
    (500, {"detail": "detail-secret"}, 502),
    (200, {"id": "wrong", "active": True, "is_authenticated": True}, 502),
    (200, {"id": "one", "active": True, "is_authenticated": None}, 502),
])
async def test_failed_or_invalid_status_is_not_reported_as_disconnected(monkeypatch, status, body, expected):
    calls = []

    async def get(self, url, **kwargs):
        calls.append(url)
        if url == "https://api.mistral.ai/v1/connectors":
            return httpx.Response(200, json={"items": [{"id": "one", "name": "One", "active": True}]},
                                  request=httpx.Request("GET", url))
        return httpx.Response(status, json=body, request=httpx.Request("GET", url))
    monkeypatch.setattr(httpx.AsyncClient, "get", get)
    with pytest.raises(HTTPException) as error:
        await read_workspace("connectors", "test-key")
    assert error.value.status_code == expected
    assert "detail-secret" not in error.value.detail
    assert len(calls) == 2


@pytest.mark.asyncio
async def test_workspace_deadline_cancels_pending_status_checks(monkeypatch):
    timeout = asyncio.timeout
    monkeypatch.setattr(asyncio, "timeout", lambda seconds: timeout(.02))
    rows = [{"id": str(i), "name": f"Service {i}", "active": True} for i in range(8)]
    running = cancelled = 0

    async def get(self, url, **kwargs):
        nonlocal running, cancelled
        if url.endswith("/connectors"):
            return httpx.Response(200, json={"items": rows}, request=httpx.Request("GET", url))
        running += 1
        try:
            await asyncio.Event().wait()
        finally:
            running -= 1
            cancelled += 1

    monkeypatch.setattr(httpx.AsyncClient, "get", get)
    with pytest.raises(HTTPException) as error:
        await read_workspace("connectors", "test-key")
    assert error.value.status_code == 502
    assert running == 0 and cancelled == 4
    assert "test-key" not in error.value.detail


@pytest.mark.asyncio
async def test_connector_identifier_is_escaped_in_status_url(monkeypatch):
    row = {"id": "service/with?query", "name": "Service", "active": True}
    calls = mock_pages(monkeypatch, [{"items": [row]}],
                       details={"service%2Fwith%3Fquery": {**row, "is_authenticated": True}})
    assert len((await read_workspace("connectors", "test-key"))["items"]) == 1
    assert calls[1][0] == "https://api.mistral.ai/v1/connectors/service%2Fwith%3Fquery"


@pytest.mark.asyncio
async def test_libraries_follow_continuation_and_keep_document_count(monkeypatch):
    calls = mock_pages(monkeypatch, [
        {"data": [{"id": "a", "name": "Research", "nb_documents": 4}], "next_page_token": "next"},
        {"data": [{"id": "b", "name": "Shared", "nb_documents": None}], "next_page_token": None},
    ])
    result = await read_workspace("libraries", "test-key")
    assert [item["documents"] for item in result["items"]] == [4, None]
    assert calls[1][1]["page_token"] == "next"


@pytest.mark.asyncio
@pytest.mark.parametrize("page", [{"items": {}}, {"items": [None]},
                                      {"items": [], "pagination": {"next_cursor": "again"}}])
async def test_bad_or_repeating_pages_fail_without_partial_results(monkeypatch, page):
    mock_pages(monkeypatch, [page])
    with pytest.raises(HTTPException) as error:
        await read_workspace("connectors", "test-key")
    assert error.value.status_code == 502
    assert "test-key" not in error.value.detail


@pytest.mark.asyncio
@pytest.mark.parametrize("status,expected", [(401, 403), (403, 403), (429, 502), (500, 502)])
async def test_upstream_errors_are_explicit_and_redacted(monkeypatch, status, expected):
    calls = mock_pages(monkeypatch, [{"detail": "private-token-and-account-data"}], status)
    with pytest.raises(HTTPException) as error:
        await read_workspace("connectors", "test-key")
    assert error.value.status_code == expected
    assert "private-token" not in error.value.detail
    assert len(calls) == 1


def test_workspace_endpoint_requires_key_and_rejects_arbitrary_resource(monkeypatch):
    monkeypatch.setattr(server, "resolve_api_key", lambda: None)
    with TestClient(server.app, base_url="http://127.0.0.1:9377") as client:
        assert client.get("/api/workspace/connectors").status_code == 400
        assert client.get("/api/workspace/not-allowed").status_code == 422
        assert client.post("/api/workspace/libraries", json={"name": "Research"}).status_code == 400
        for body in ({"name": "  "}, {"name": "x" * 257}, {"name": "Research", "owner_type": "User"}):
            assert client.post("/api/workspace/libraries", json=body).status_code == 422


@pytest.mark.asyncio
async def test_create_library_uses_shared_workspace_and_returns_only_safe_fields(monkeypatch):
    calls = []

    async def post(self, url, *, headers, json):
        calls.append((url, headers, json))
        return httpx.Response(201, json={"id": "created", "owner_id": "private-account", "token": "secret"},
                              request=httpx.Request("POST", url))
    monkeypatch.setattr(httpx.AsyncClient, "post", post)
    result = await create_library("Research", "Sources", "test-key")
    assert result == {"id": "created", "name": "Research", "description": "Sources", "documents": 0}
    assert calls == [("https://api.mistral.ai/v1/libraries", {"Authorization": "Bearer test-key"},
                      {"name": "Research", "description": "Sources", "owner_type": "Workspace"})]


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [403, 500, None])
async def test_library_creation_failures_never_retry_or_leak_details(monkeypatch, status):
    calls = []

    async def post(self, url, **kwargs):
        calls.append(url)
        if status is None:
            raise httpx.ReadTimeout("private-token")
        return httpx.Response(status, json={"detail": "private-token"}, request=httpx.Request("POST", url))
    monkeypatch.setattr(httpx.AsyncClient, "post", post)
    with pytest.raises(HTTPException) as error:
        await create_library("Research", "", "test-key")
    assert error.value.status_code == (403 if status == 403 else 502)
    assert "private-token" not in error.value.detail
    assert len(calls) == 1
    if status != 403:
        assert "Refresh Libraries before trying again" in error.value.detail


def test_library_route_strips_whitespace(monkeypatch):
    import workspace
    calls = []

    async def create(name, description, key):
        calls.append((name, description, key))
        return {"id": "created"}
    monkeypatch.setattr(server, "resolve_api_key", lambda: "test-key")
    monkeypatch.setattr(workspace, "create_library", create)
    with TestClient(server.app, base_url="http://127.0.0.1:9377") as client:
        response = client.post("/api/workspace/libraries", json={"name": " Research ", "description": " Sources "})
        assert response.status_code == 201
    assert calls == [("Research", "Sources", "test-key")]
