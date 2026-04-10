"""Pydantic models for the Veto admin client."""

from __future__ import annotations

from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, Field, model_validator


class AdminModel(BaseModel):
    """Base model for admin API payloads."""

    model_config = ConfigDict(populate_by_name=True, extra="allow")

    @model_validator(mode="before")
    @classmethod
    def _normalize_ids(cls, value: Any) -> Any:
        if isinstance(value, dict) and "id" not in value and "_id" in value:
            out = dict(value)
            out["id"] = out["_id"]
            return out
        return value


class VetoAdminConfig(AdminModel):
    """Configuration for the Veto admin client."""

    api_key: Optional[str] = None
    base_url: str = "https://api.veto.so"
    timeout: int = 30000
    retries: int = 2
    retry_delay: int = 1000


class CreateOrganizationRequest(AdminModel):
    name: str


class CreateProjectRequest(AdminModel):
    organization_id: str = Field(alias="organizationId")
    name: str


class CreateApiKeyRequest(AdminModel):
    project_id: str = Field(alias="projectId")
    name: str


class Organization(AdminModel):
    id: str
    name: str
    slug: Optional[str] = None
    created_at: Optional[str] = Field(default=None, alias="createdAt")


class Project(AdminModel):
    id: str
    name: str
    organization_id: Optional[str] = Field(default=None, alias="organizationId")
    slug: Optional[str] = None
    created_at: Optional[str] = Field(default=None, alias="createdAt")


class ApiKeyCreated(AdminModel):
    id: str
    name: str
    key: str
    key_prefix: str = Field(alias="keyPrefix")
    created_at: Optional[str] = Field(default=None, alias="createdAt")
    warning: Optional[str] = None


class OrganizationListResponse(AdminModel):
    data: list[Organization]


class ProjectListResponse(AdminModel):
    data: list[Project]
