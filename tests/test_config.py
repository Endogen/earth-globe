from concurrent.futures import ThreadPoolExecutor

import pytest

from earth_globe_demo import config


def test_concurrent_startups_share_one_control_key(tmp_path, monkeypatch):
    monkeypatch.delenv("EARTH_GLOBE_ADMIN_TOKEN", raising=False)
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    monkeypatch.setattr(config, "TRACKING_ADMIN_TOKEN_FILE", tmp_path / "key.txt")
    with ThreadPoolExecutor(max_workers=8) as pool:
        tokens = list(pool.map(lambda _: config.get_or_create_tracking_admin_token(), range(16)))
    assert len(set(tokens)) == 1
    assert len(tokens[0]) >= 24
    assert (tmp_path / "key.txt").stat().st_mode & 0o777 == 0o600


def test_invalid_saved_key_is_not_silently_replaced(tmp_path, monkeypatch):
    monkeypatch.delenv("EARTH_GLOBE_ADMIN_TOKEN", raising=False)
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    key = tmp_path / "key.txt"
    monkeypatch.setattr(config, "TRACKING_ADMIN_TOKEN_FILE", key)
    key.write_text("damaged")
    with pytest.raises(RuntimeError, match="invalid"):
        config.get_or_create_tracking_admin_token()
    assert key.read_text() == "damaged"
