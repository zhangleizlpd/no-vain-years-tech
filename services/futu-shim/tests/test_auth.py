from futu_shim.auth import extract_token, is_authorized


def test_extract_token_accepts_case_insensitive_scheme():
    assert extract_token("Bearer abc123") == "abc123"
    assert extract_token("bearer abc123") == "abc123"
    assert extract_token("  Bearer   abc123  ") == "abc123"


def test_extract_token_rejects_malformed_headers():
    assert extract_token(None) is None
    assert extract_token("") is None
    assert extract_token("abc123") is None  # no scheme
    assert extract_token("Basic abc123") is None  # wrong scheme
    assert extract_token("Bearer") is None  # scheme only
    assert extract_token("Bearer   ") is None  # empty credential


def test_is_authorized_happy_path(monkeypatch):
    monkeypatch.setenv("FUTU_SHIM_TOKEN", "s3cret")
    assert is_authorized("s3cret") is True


def test_is_authorized_fails_closed_when_token_unset(monkeypatch):
    """The most important negative: an unconfigured service must deny, not
    open. Presenting *anything* — including an empty string — stays denied."""
    monkeypatch.delenv("FUTU_SHIM_TOKEN", raising=False)
    assert is_authorized("anything") is False
    assert is_authorized("") is False
    assert is_authorized(None) is False


def test_is_authorized_rejects_wrong_and_missing_tokens(monkeypatch):
    monkeypatch.setenv("FUTU_SHIM_TOKEN", "s3cret")
    assert is_authorized("wrong") is False
    assert is_authorized(None) is False
    assert is_authorized("s3cre") is False  # prefix, different length
    assert is_authorized("s3crets") is False  # superstring


def test_blank_env_token_is_treated_as_unset(monkeypatch):
    """Whitespace-only config must not become a usable credential."""
    monkeypatch.setenv("FUTU_SHIM_TOKEN", "   ")
    assert is_authorized("   ") is False
