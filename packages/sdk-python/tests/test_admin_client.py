"""Tests for the Python Veto admin client."""

from __future__ import annotations

from aiohttp import web
import pytest
import pytest_asyncio

from veto.admin import VetoAdmin


@pytest_asyncio.fixture
async def admin_server() -> str:
    async def list_organizations(request: web.Request) -> web.Response:
        assert request.headers["X-Veto-API-Key"] == "test-key"
        return web.json_response(
            {
                "data": [
                    {
                        "id": "org_1",
                        "name": "Acme",
                        "slug": "acme",
                        "createdAt": "2026-04-10T00:00:00Z",
                    }
                ]
            }
        )

    async def create_organization(request: web.Request) -> web.Response:
        payload = await request.json()
        return web.json_response(
            {
                "id": "org_new",
                "name": payload["name"],
                "slug": "acme-new",
                "createdAt": "2026-04-10T00:00:00Z",
            }
        )

    async def list_projects(request: web.Request) -> web.Response:
        assert request.query["organizationId"] == "org_1"
        return web.json_response(
            {
                "data": [
                    {
                        "id": "proj_1",
                        "name": "Sandbox",
                        "organizationId": request.query["organizationId"],
                        "createdAt": "2026-04-10T00:00:00Z",
                    }
                ]
            }
        )

    async def create_project(request: web.Request) -> web.Response:
        payload = await request.json()
        return web.json_response(
            {
                "id": "proj_new",
                "name": payload["name"],
                "organizationId": payload["organizationId"],
                "createdAt": "2026-04-10T00:00:00Z",
            }
        )

    async def create_api_key(request: web.Request) -> web.Response:
        payload = await request.json()
        return web.json_response(
            {
                "id": "key_1",
                "name": payload["name"],
                "key": "veto_abcdefghijklmnopqrstuvwxyz",
                "keyPrefix": "veto_abcd...",
                "createdAt": "2026-04-10T00:00:00Z",
                "warning": "save me",
            },
            status=201,
        )

    app = web.Application()
    app.router.add_get("/v1/organizations", list_organizations)
    app.router.add_post("/v1/organizations", create_organization)
    app.router.add_get("/v1/projects", list_projects)
    app.router.add_post("/v1/projects", create_project)
    app.router.add_post("/v1/api-keys", create_api_key)

    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    assert site._server is not None and site._server.sockets is not None
    port = site._server.sockets[0].getsockname()[1]

    try:
        yield f"http://127.0.0.1:{port}"
    finally:
        await runner.cleanup()


@pytest.mark.asyncio
async def test_admin_client_crud(admin_server: str) -> None:
    async with VetoAdmin(api_key="test-key", base_url=admin_server) as admin:
        created_org = await admin.create_organization("Acme")
        assert created_org.id == "org_new"
        assert created_org.name == "Acme"

        orgs = await admin.list_organizations()
        assert len(orgs) == 1
        assert orgs[0].slug == "acme"

        created_project = await admin.create_project("org_1", "Sandbox")
        assert created_project.organization_id == "org_1"

        projects = await admin.list_projects("org_1")
        assert projects[0].name == "Sandbox"

        created_key = await admin.create_api_key("proj_1", "Partner Key")
        assert created_key.key.startswith("veto_")
        assert created_key.key_prefix == "veto_abcd..."
