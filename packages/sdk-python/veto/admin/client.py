"""Async Veto admin client for organization/project/key management."""

from __future__ import annotations

import asyncio
import os
from typing import Any, Optional, TypeVar

import aiohttp
from pydantic import BaseModel

from veto.admin.types import (
    ApiKeyCreated,
    CreateApiKeyRequest,
    CreateOrganizationRequest,
    CreateProjectRequest,
    Organization,
    OrganizationListResponse,
    Project,
    ProjectListResponse,
    VetoAdminConfig,
)

ModelT = TypeVar("ModelT", bound=BaseModel)


class VetoAdminError(Exception):
    """Raised when the admin API returns an error."""

    def __init__(self, message: str, status_code: int):
        super().__init__(message)
        self.status_code = status_code


class VetoAdmin:
    """Async client for Veto admin endpoints."""

    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: str = "https://api.veto.so",
        timeout: int = 30000,
        *,
        retries: int = 2,
        retry_delay: int = 1000,
    ):
        self._config = VetoAdminConfig(
            api_key=api_key,
            base_url=base_url,
            timeout=timeout,
            retries=retries,
            retry_delay=retry_delay,
        )
        self._api_key = self._config.api_key or os.environ.get("VETO_API_KEY")
        if not self._api_key:
            raise ValueError("VetoAdmin requires an api_key or VETO_API_KEY")

        self._base_url = self._config.base_url.rstrip("/")
        self._session: Optional[aiohttp.ClientSession] = None

    def _get_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=self._config.timeout / 1000),
                headers=self._get_headers(),
            )
        return self._session

    def _get_headers(self) -> dict[str, str]:
        return {
            "Content-Type": "application/json",
            "X-Veto-API-Key": self._api_key or "",
        }

    def _build_url(self, path: str) -> str:
        return f"{self._base_url}/v1{path}"

    async def close(self) -> None:
        if self._session and not self._session.closed:
            await self._session.close()
            self._session = None

    async def __aenter__(self) -> "VetoAdmin":
        return self

    async def __aexit__(self, exc_type: object, exc: object, tb: object) -> None:
        await self.close()

    async def create_organization(self, name: str) -> Organization:
        payload = CreateOrganizationRequest(name=name)
        return await self._request_model(
            "POST",
            "/organizations",
            Organization,
            body=payload.model_dump(by_alias=True, exclude_none=True),
        )

    async def create_project(self, org_id: str, name: str) -> Project:
        payload = CreateProjectRequest(organizationId=org_id, name=name)
        return await self._request_model(
            "POST",
            "/projects",
            Project,
            body=payload.model_dump(by_alias=True, exclude_none=True),
        )

    async def create_api_key(self, project_id: str, name: str) -> ApiKeyCreated:
        payload = CreateApiKeyRequest(projectId=project_id, name=name)
        return await self._request_model(
            "POST",
            "/api-keys",
            ApiKeyCreated,
            body=payload.model_dump(by_alias=True, exclude_none=True),
        )

    async def list_organizations(self) -> list[Organization]:
        response = await self._request_model(
            "GET",
            "/organizations",
            OrganizationListResponse,
        )
        return response.data

    async def list_projects(self, org_id: str) -> list[Project]:
        response = await self._request_model(
            "GET",
            "/projects",
            ProjectListResponse,
            params={"organizationId": org_id},
        )
        return response.data

    async def _request_model(
        self,
        method: str,
        path: str,
        model: type[ModelT],
        *,
        params: Optional[dict[str, str]] = None,
        body: Optional[dict[str, Any]] = None,
    ) -> ModelT:
        data = await self._request_json(method, path, params=params, body=body)
        return model.model_validate(data)

    async def _request_json(
        self,
        method: str,
        path: str,
        *,
        params: Optional[dict[str, str]] = None,
        body: Optional[dict[str, Any]] = None,
    ) -> dict[str, Any]:
        last_error: Optional[Exception] = None
        url = self._build_url(path)

        for attempt in range(self._config.retries + 1):
            try:
                session = self._get_session()
                async with session.request(method, url, params=params, json=body) as response:
                    if not response.ok:
                        error_text = await response.text()
                        raise VetoAdminError(
                            f"{method} {path} failed ({response.status}): {error_text}",
                            response.status,
                        )

                    if response.status == 204:
                        return {}

                    payload = await response.json()
                    if not isinstance(payload, dict):
                        raise VetoAdminError(
                            f"{method} {path} returned non-object JSON payload",
                            response.status,
                        )
                    return payload
            except VetoAdminError as error:
                last_error = error
                if error.status_code < 500 or attempt >= self._config.retries:
                    raise
            except Exception as error:
                last_error = error if isinstance(error, Exception) else Exception(str(error))
                if attempt >= self._config.retries:
                    break

            await asyncio.sleep(self._config.retry_delay / 1000)

        if isinstance(last_error, VetoAdminError):
            raise last_error

        raise VetoAdminError(
            f"{method} {path} failed: {last_error}",
            0,
        )
