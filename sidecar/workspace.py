"""Mistral workspace metadata and library creation. Never return credentials."""
import asyncio
from typing import Literal
from urllib.parse import quote

import httpx
from fastapi import HTTPException
from mistral_api import MISTRAL_BASE

_CONNECTOR_NAMES = {"github_app": "GitHub", "gmail": "Gmail", "outlook": "Outlook",
                    "google_calendar": "Google Calendar", "google_drive_mcp": "Google Drive"}


async def create_library(name: str, description: str, key: str) -> dict:
    try:
        async with httpx.AsyncClient(timeout=25, follow_redirects=False) as client:
            response = await client.post(f"{MISTRAL_BASE}/libraries", headers={"Authorization": f"Bearer {key}"},
                                         json={"name": name, "description": description, "owner_type": "Workspace"})
            response.raise_for_status()
            body = response.json()
            if not isinstance(body["id"], str) or not body["id"]:
                raise ValueError("Invalid library ID")
            return {"id": body["id"], "name": name, "description": description, "documents": 0}
    except httpx.HTTPStatusError as error:
        if error.response.status_code in (401, 403):
            raise HTTPException(403, "This Mistral API key cannot create a library in this workspace. Check its access in the web app.") from None
        raise HTTPException(502, "Mistral could not confirm library creation. Refresh Libraries before trying again.") from None
    except (httpx.HTTPError, ValueError, KeyError, TypeError):
        raise HTTPException(502, "Library creation status is unconfirmed. Refresh Libraries before trying again.") from None


async def read_workspace(kind: Literal["connectors", "libraries"], key: str) -> dict:
    items = {}
    cursor = None
    seen = set()
    statuses = {}
    headers = {"Authorization": f"Bearer {key}"}
    try:
        async with asyncio.timeout(25), httpx.AsyncClient(timeout=10, follow_redirects=False) as client:
            limit = asyncio.Semaphore(4)

            async def connector_status(connector_id):
                async with limit:
                    response = await client.get(f"{MISTRAL_BASE}/connectors/{quote(connector_id, safe='')}",
                                                params={"fetch_user_data": "true", "fetch_customer_data": "false"},
                                                headers=headers)
                    response.raise_for_status()
                    status = response.json()
                    if (status.get("id") != connector_id or type(status.get("active")) is not bool
                            or type(status.get("is_authenticated")) is not bool):
                        raise ValueError("Invalid connector status")
                    return connector_id, status["active"] and status["is_authenticated"]

            for _ in range(10):
                params = {"page_size": "100"}
                if kind == "connectors":
                    params["active"] = "true"
                if cursor:
                    params["cursor" if kind == "connectors" else "page_token"] = cursor
                response = await client.get(f"{MISTRAL_BASE}/{kind}", params=params,
                                            headers=headers)
                response.raise_for_status()
                body = response.json()
                rows = body["items" if kind == "connectors" else "data"]
                if not isinstance(rows, list) or len(rows) > 100:
                    raise ValueError("Invalid workspace list")
                if kind == "connectors":
                    candidates = {}
                    for row in rows:
                        if row.get("active") is not True or (row.get("owner_type") == "system" and row.get("name") == "document_library"):
                            continue
                        if not isinstance(row["id"], str) or not row["id"]:
                            raise ValueError("Invalid connector ID")
                        candidates[row["id"]] = row
                    # The list omits user auth; resolve status before filtering, without retaining credentials.
                    results = await asyncio.gather(*(connector_status(cid) for cid in candidates if cid not in statuses),
                                                   return_exceptions=True)
                    for result in results:
                        if isinstance(result, BaseException):
                            raise result
                        statuses[result[0]] = result[1]
                    rows = [row for cid, row in candidates.items() if statuses[cid]]
                for row in rows:
                    item = {field: row[field] for field in ("id", "name")}
                    if not all(isinstance(value, str) and value for value in item.values()):
                        raise ValueError("Invalid workspace item")
                    title = row.get("title")
                    item["name"] = title if isinstance(title, str) and title else item["name"]
                    if kind == "connectors" and not title:
                        item["name"] = _CONNECTOR_NAMES.get(item["name"], item["name"])
                    description = row.get("description")
                    item["description"] = description if isinstance(description, str) else ""
                    if kind == "connectors":
                        item["connected"] = True
                    else:
                        count = row.get("nb_documents")
                        item["documents"] = count if type(count) is int and count >= 0 else None
                    items[item["id"]] = item
                cursor = ((body.get("pagination") or {}).get("next_cursor") if kind == "connectors"
                          else body.get("next_page_token"))
                if cursor is None:
                    return {"items": list(items.values()), "source": "mistral-api"}
                if not isinstance(cursor, str) or not cursor or cursor in seen:
                    raise ValueError("Invalid workspace cursor")
                seen.add(cursor)
            raise ValueError("Workspace page limit exceeded")
    except httpx.HTTPStatusError as error:
        if error.response.status_code in (401, 403):
            raise HTTPException(403, "This Mistral API key cannot read the workspace. Check its account and connector access scope in the web app.") from None
        raise HTTPException(502, "Mistral workspace is unavailable. Try again or open the web app.") from None
    except (httpx.HTTPError, TimeoutError, ValueError, KeyError, TypeError, AttributeError):
        raise HTTPException(502, "Mistral workspace could not be read. Try again or open the web app.") from None
