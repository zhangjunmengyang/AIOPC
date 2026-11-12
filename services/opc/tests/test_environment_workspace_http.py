import json

from starlette.testclient import TestClient

from aiopc.server import create_api


def test_desktop_company_allowlist_limits_http_workspaces_and_rechecks_cached_projects(tmp_path, monkeypatch):
    company = tmp_path / "company"
    alpha = company / "projects" / "alpha"
    beta = company / "projects" / "beta"
    neighboring_project = tmp_path / "company-other" / "projects" / "neighbor"
    unrelated = tmp_path / "outside"
    for path in (alpha, beta, neighboring_project, unrelated):
        path.mkdir(parents=True)
    alias = company / "projects" / "alias"
    alias.symlink_to(neighboring_project, target_is_directory=True)

    allowlist = tmp_path / "authorized-companies.json"

    def authorize(*roots):
        temporary = allowlist.with_suffix(".tmp")
        temporary.write_text(json.dumps({"version": 1, "roots": [str(root.resolve()) for root in roots]}), encoding="utf-8")
        temporary.chmod(0o600)
        temporary.replace(allowlist)

    authorize(company)
    monkeypatch.setenv("AIOPC_AUTHORIZED_COMPANIES_FILE", str(allowlist))
    with TestClient(create_api(tmp_path / "home", "local-test-token"), headers={"Authorization": "Bearer local-test-token"}) as client:
        def get_project(path):
            return client.get("/api/project", params={"workspace": str(path)})

        for path in (company, alpha, beta):
            response = get_project(path)
            assert response.status_code == 200, response.text
            assert response.json()["path"] == str(path.resolve())
        for path in (neighboring_project, unrelated, alias):
            response = get_project(path)
            assert response.status_code == 403, f"{path}: {response.status_code} {response.text}"
        authorize()
        response = get_project(alpha)
        assert response.status_code == 403, response.text


def test_invalid_company_allowlist_returns_access_denied(tmp_path, monkeypatch):
    company = tmp_path / "company"
    company.mkdir()
    allowlist = tmp_path / "authorized-companies.json"
    allowlist.write_text("[]", encoding="utf-8")
    allowlist.chmod(0o600)
    monkeypatch.setenv("AIOPC_AUTHORIZED_COMPANIES_FILE", str(allowlist))
    with TestClient(create_api(tmp_path / "home", "local-test-token"), raise_server_exceptions=False) as client:
        response = client.get("/api/project", params={"workspace": str(company)}, headers={"Authorization": "Bearer local-test-token"})
    assert response.status_code == 403, response.text
