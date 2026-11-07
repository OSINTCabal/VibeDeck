"""Unit tests for the SQLite store."""
from store import Store


def test_session_crud(tmp_path):
    s = Store(tmp_path / "t.db")
    s.upsert_session("abc", title="Test", cwd="/tmp", agent="ask", model="mistral-large-4",
                     reasoning=None, lane="code", status="idle")
    row = s.get_session("abc")
    assert row["title"] == "Test"
    assert row["agent"] == "ask"
    assert row["lane"] == "code"

    rows = s.list_sessions()
    assert len(rows) == 1

    s.set_session_status("abc", "running")
    assert s.get_session("abc")["status"] == "running"

    s.delete_session("abc")
    assert s.get_session("abc") is None


def test_costs_and_total(tmp_path):
    s = Store(tmp_path / "t.db")
    s.upsert_costs("abc", {"sessionPromptTokens": 1000, "sessionCompletionTokens": 200,
                           "sessionCachedTokens": 0, "inputPricePerMillion": 2.0,
                           "outputPricePerMillion": 6.0})
    c = s.get_costs("abc")
    assert c["prompt_tokens"] == 1000
    total = s.total_costs()
    # (1000*2 + 200*6)/1e6 = 0.0032
    assert abs(total["estimated_cost_usd"] - 0.0032) < 1e-9


def test_list_sessions_with_costs(tmp_path):
    s = Store(tmp_path / "t.db")
    s.upsert_session("a", title="A", cwd="/tmp", agent="ask", model="mistral-large-4",
                     reasoning=None, lane="code", status="idle")
    s.upsert_session("b", title="B", cwd="/tmp", agent="ask", model="mistral-large-4",
                     reasoning=None, lane="work", status="idle")
    s.upsert_costs("a", {"sessionPromptTokens": 100, "sessionCompletionTokens": 50,
                         "sessionCachedTokens": 0, "inputPricePerMillion": 2.0,
                         "outputPricePerMillion": 6.0})
    rows = s.list_sessions_with_costs()
    assert len(rows) == 2
    by_id = {r["id"]: r for r in rows}
    assert by_id["a"]["costs"]["prompt_tokens"] == 100
    assert by_id["a"]["costs"]["completion_tokens"] == 50
    assert by_id["a"]["costs"]["input_price_per_million"] == 2.0
    # session without a cost row gets zeros, not a crash
    assert by_id["b"]["costs"]["prompt_tokens"] == 0
    # cost columns are folded into the costs dict, not left on the row
    assert "prompt_tokens" not in by_id["a"]


def test_config_and_audit(tmp_path):
    s = Store(tmp_path / "t.db")
    assert s.get_config("default_model", "mistral-large-4") == "mistral-large-4"
    s.set_config("default_model", "mistral-large-4")
    assert s.get_config("default_model") == "mistral-large-4"
    s.audit("test", "hello")
    assert s.list_audit()[0]["action"] == "test"


def test_migration_adds_columns(tmp_path):
    """An old DB with agent_mode should be migrated to the new schema."""
    import sqlite3
    db = tmp_path / "old.db"
    con = sqlite3.connect(db)
    con.executescript("""
      CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, cwd TEXT,
        agent_mode TEXT DEFAULT 'plan', model TEXT, status TEXT,
        created_at REAL, updated_at REAL);
      INSERT INTO sessions(id,title,cwd,agent_mode,model,status,created_at,updated_at)
        VALUES('x','Old','/tmp','plan','mistral-large-latest','idle',0,0);
    """)
    con.commit()
    con.close()
    s = Store(db)  # runs migration
    row = s.get_session("x")
    assert row["agent"] == "plan"  # migrated from agent_mode
    assert "lane" in row and "reasoning" in row
