output "namespace" { value = kubernetes_namespace.veto.metadata[0].name }
output "helm_release" { value = helm_release.veto_operator.name }
output "tenant_id" { value = data.azurerm_client_config.current.tenant_id }
output "server_service" { value = "veto-veto-operator-server.${var.namespace}.svc.cluster.local:3001" }
