"""HTTP routes for the Knowledge base module.

Two audiences:
- people in the dashboard (JWT with admin:manage or knowledge:review), who
  read what the knowledge base produced and decide on its proposals;
- the laptop that holds the knowledge base (the X-KB-Token header, checked
  against KB_SYNC_TOKEN), which pushes what it produced and pulls decisions.
  Those routes touch only the kb_* tables.
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

import knowledge_base as kb
from auth_middleware import require_any_permission, require_kb_sync_token

router = APIRouter()
_reviewer = require_any_permission("admin:manage", "knowledge:review")
_laptop = [Depends(require_kb_sync_token)]


def _who(payload: dict) -> str:
    return str(payload.get("username") or payload.get("sub") or "unknown")


def _page(limit: int, offset: int, most: int = 100) -> tuple[int, int]:
    return min(max(limit, 1), most), max(offset, 0)


# ── people ──────────────────────────────────────────────────────────────────

@router.get("/kb/overview")
def kb_overview(_: dict = Depends(_reviewer)) -> dict:
    return kb.overview()


@router.get("/kb/review-items")
def kb_review_items(view: str = "pending", kind: str | None = None, exclude_kind: str | None = None,
                    limit: int = 20, offset: int = 0, _: dict = Depends(_reviewer)) -> dict:
    if view not in ("pending", "decided", "done", "all"):
        raise HTTPException(400, "view must be pending, decided, done or all")
    items, has_more = kb.list_review_items(view, kind, exclude_kind, *_page(limit, offset))
    return {"items": items, "has_more": has_more}


class DecisionRequest(BaseModel):
    decision: str
    answer: str | None = None


@router.post("/kb/review-items/{item_id}/decision")
def kb_decide(item_id: str, req: DecisionRequest, payload: dict = Depends(_reviewer)) -> dict:
    try:
        return {"item": kb.decide_review_item(item_id, req.decision, req.answer, _who(payload))}
    except LookupError:
        raise HTTPException(404, "Review item not found")
    except ValueError as exc:
        raise HTTPException(409, str(exc))


# No body: which item, and who is asking, is all an install needs.
@router.post("/kb/review/{item_id}/install")
def kb_request_install(item_id: str, payload: dict = Depends(_reviewer)) -> dict:
    try:
        return {"item": kb.request_install(item_id, _who(payload))}
    except LookupError:
        raise HTTPException(404, "Review item not found")
    except ValueError as exc:
        raise HTTPException(409, str(exc))


@router.get("/kb/agent-state")
def kb_agent_state(_: dict = Depends(_reviewer)) -> dict:
    """What the laptop last reported, so the Install button knows whether it
    can be pressed and what to say when it cannot."""
    return {"repos": kb.agent_state()}


@router.get("/kb/rules")
def kb_rules(_: dict = Depends(_reviewer)) -> dict:
    return {"rules": kb.list_rules()}


@router.delete("/kb/rules/{rule_id}")
def kb_delete_rule(rule_id: int, _: dict = Depends(_reviewer)) -> dict:
    if not kb.delete_rule(rule_id):
        raise HTTPException(404, "Rule not found")
    return {"ok": True}


@router.get("/kb/documents")
def kb_documents(q: str | None = None, kind: str | None = None, topic: str | None = None,
                 limit: int = 20, offset: int = 0, _: dict = Depends(_reviewer)) -> dict:
    documents, has_more = kb.list_documents((q or "").strip() or None, kind, topic, *_page(limit, offset))
    return {"documents": documents, "has_more": has_more}


@router.get("/kb/documents/item")
def kb_document(path: str, _: dict = Depends(_reviewer)) -> dict:
    document = kb.get_document(path)
    if not document:
        raise HTTPException(404, "Document not found")
    return document


@router.get("/kb/runs")
def kb_runs(limit: int = 20, offset: int = 0, _: dict = Depends(_reviewer)) -> dict:
    runs, has_more = kb.list_runs(*_page(limit, offset))
    return {"runs": runs, "has_more": has_more}


@router.get("/kb/change-log")
def kb_change_log(limit: int = 20, offset: int = 0, _: dict = Depends(_reviewer)) -> dict:
    items, has_more = kb.list_change_log(*_page(limit, offset))
    return {"items": items, "has_more": has_more}


# ── the laptop ──────────────────────────────────────────────────────────────

def _batch(rows: list, what: str) -> None:
    if len(rows) > kb.MAX_BATCH:
        raise HTTPException(413, f"At most {kb.MAX_BATCH} {what} per call")


class SyncDocuments(BaseModel):
    documents: list[dict[str, Any]]


@router.post("/kb/sync/documents", dependencies=_laptop)
def sync_documents(req: SyncDocuments) -> dict:
    _batch(req.documents, "documents")
    return {"upserted": kb.upsert_documents(req.documents)}


class SyncReviewItems(BaseModel):
    run_id: str | None = None
    items: list[dict[str, Any]]


@router.post("/kb/sync/review-items", dependencies=_laptop)
def sync_review_items(req: SyncReviewItems) -> dict:
    _batch(req.items, "items")
    stored, rejected = kb.upsert_review_items(req.items, req.run_id)
    return {"stored": stored, "rejected": rejected}


class SyncRun(BaseModel):
    run: dict[str, Any]


@router.post("/kb/sync/runs", dependencies=_laptop)
def sync_run(req: SyncRun) -> dict:
    try:
        kb.record_run(req.run)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    return {"ok": True}


@router.get("/kb/sync/decisions", dependencies=_laptop)
def sync_decisions() -> dict:
    return {"items": kb.pending_decisions()}


class SyncApplied(BaseModel):
    ids: list[str]


@router.post("/kb/sync/review-items/applied", dependencies=_laptop)
def sync_applied(req: SyncApplied) -> dict:
    _batch(req.ids, "ids")
    return {"done": kb.mark_applied(req.ids)}


@router.get("/kb/sync/rules", dependencies=_laptop)
def sync_rules() -> dict:
    return {"rules": kb.list_rules()}


class AgentHeartbeat(BaseModel):
    at: str | None = None
    candidates: list[dict[str, Any]] = []
    repos: dict[str, dict[str, Any]] = {}


@router.post("/kb/sync/agent/heartbeat", dependencies=_laptop)
def sync_agent_heartbeat(req: AgentHeartbeat) -> dict:
    """The five-minute heartbeat: what the laptop sees, and what it should do.
    An empty install_requests is the normal answer."""
    _batch(req.candidates, "candidates")
    try:
        return {"install_requests": kb.record_agent_heartbeat(req.model_dump())}
    except ValueError as exc:
        raise HTTPException(400, str(exc))


class AgentInstallResult(BaseModel):
    id: str
    state: str
    commit: str | None = None
    message: str | None = None


@router.post("/kb/sync/agent/install-result", dependencies=_laptop)
def sync_agent_install_result(req: AgentInstallResult) -> dict:
    try:
        return {"item": kb.record_install_result(req.id, req.state, req.commit, req.message)}
    except LookupError:
        raise HTTPException(404, "Review item not found")
    except ValueError as exc:
        raise HTTPException(400, str(exc))

