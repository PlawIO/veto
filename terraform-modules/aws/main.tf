data "aws_caller_identity" "current" {}

resource "kubernetes_namespace" "veto" {
  metadata { name = var.namespace }
}

resource "helm_release" "veto_operator" {
  name       = "veto"
  namespace  = kubernetes_namespace.veto.metadata[0].name
  repository = "oci://ghcr.io/plawio/charts"
  chart      = "veto-operator"
  version    = var.chart_version

  set_sensitive {
    name  = "license"
    value = var.license
  }
  set {
    name  = "images.operator.digest"
    value = var.operator_digest
  }
  set {
    name  = "images.server.digest"
    value = var.server_digest
  }
  set {
    name  = "images.dashboard.digest"
    value = var.dashboard_digest
  }
  set {
    name  = "storage.driver"
    value = var.storage_driver
  }
  set {
    name  = "telemetry.enabled"
    value = tostring(var.telemetry_enabled)
  }
  set_list {
    name  = "networkPolicy.fqdn.allowedNames"
    value = var.outbound_hosts
  }
}

resource "kubernetes_manifest" "veto_cluster" {
  manifest = {
    apiVersion = "veto.plaw.io/v1alpha1"
    kind       = "VetoCluster"
    metadata = {
      name      = "veto"
      namespace = kubernetes_namespace.veto.metadata[0].name
    }
    spec = {
      licenseRef = { secretName = "veto-veto-operator-license", key = "license" }
      server = {
        replicas      = 2
        image         = "ghcr.io/plawio/veto-server@${var.server_digest}"
        storageDriver = var.storage_driver
      }
      dashboard = {
        replicas = 1
        image    = "ghcr.io/plawio/veto-dashboard@${var.dashboard_digest}"
      }
      telemetry = { enabled = var.telemetry_enabled }
      outbound  = { allowedHosts = var.outbound_hosts }
    }
  }

  depends_on = [helm_release.veto_operator]
}
