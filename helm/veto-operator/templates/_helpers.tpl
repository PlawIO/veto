{{- define "veto.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "veto.fullname" -}}
{{- printf "%s-%s" .Release.Name (include "veto.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "veto.labels" -}}
app.kubernetes.io/name: {{ include "veto.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version | replace "+" "_" }}
{{- end -}}

{{- define "veto.image" -}}
{{- printf "%s@%s" .repository .digest -}}
{{- end -}}
