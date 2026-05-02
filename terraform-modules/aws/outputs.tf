output "namespace" { value = kubernetes_namespace.veto.metadata[0].name }
output "helm_release" { value = helm_release.veto_operator.name }
output "aws_account_id" { value = data.aws_caller_identity.current.account_id }
output "server_service" { value = "veto-veto-operator-server.${var.namespace}.svc.cluster.local:3001" }
