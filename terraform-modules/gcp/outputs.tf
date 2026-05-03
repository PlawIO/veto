output "namespace" { value = kubernetes_namespace.veto.metadata[0].name }
output "helm_release" { value = helm_release.veto_operator.name }
output "project_number" { value = data.google_project.current.number }
output "server_service" { value = "veto-veto-operator-server.${var.namespace}.svc.cluster.local:3001" }
