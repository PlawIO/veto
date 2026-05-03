terraform {
  required_version = ">= 1.6.0"
  required_providers {
    azurerm = { source = "hashicorp/azurerm", version = ">= 3.100" }
    helm = { source = "hashicorp/helm", version = ">= 2.13" }
    kubernetes = { source = "hashicorp/kubernetes", version = ">= 2.30" }
  }
}
