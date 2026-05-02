variable "project_id" {
  type = string
}

variable "cluster_name" {
  type = string
}

variable "location" {
  type = string
}

variable "namespace" {
  type    = string
  default = "veto-system"
}

variable "license" {
  type      = string
  sensitive = true
}

variable "chart_version" {
  type    = string
  default = "0.1.0"
}

variable "operator_digest" {
  type = string
}

variable "server_digest" {
  type = string
}

variable "dashboard_digest" {
  type = string
}

variable "storage_driver" {
  type    = string
  default = "sqlite"
}

variable "telemetry_enabled" {
  type    = bool
  default = false
}

variable "outbound_hosts" {
  type    = list(string)
  default = ["ghcr.io", "license.veto.so", "telemetry.veto.so"]
}
