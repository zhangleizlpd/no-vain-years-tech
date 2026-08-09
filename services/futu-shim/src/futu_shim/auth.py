"""Bearer-token auth.

Direct port of `services/code-index/src/auth.ts` so both internal services
authenticate identically: constant-time compare, fail-closed on an unset token.
"""

from __future__ import annotations

import hmac

from .config import service_token


def extract_token(auth_header: str | None) -> str | None:
    """Pull the token out of an `Authorization: Bearer <token>` header."""
    if not auth_header:
        return None
    parts = auth_header.strip().split(None, 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        return None
    return parts[1].strip() or None


def is_authorized(presented: str | None) -> bool:
    """Constant-time check against the configured token.

    Fail-closed: an unset configured token or a missing presented token never
    authorizes. `hmac.compare_digest` is constant-time over equal-length inputs
    and short-circuits only on length, which is not the secret.
    """
    expected = service_token()
    if not expected or not presented:
        return False
    return hmac.compare_digest(presented.encode("utf-8"), expected.encode("utf-8"))
