import { CfnOutput } from 'aws-cdk-lib';
import * as eks from 'aws-cdk-lib/aws-eks';
import { Construct } from 'constructs';

export interface VetoClusterProps {
  license: string;
  cluster?: eks.ICluster;
  namespace?: string;
  chartVersion?: string;
  operatorDigest?: string;
  serverDigest?: string;
  dashboardDigest?: string;
  telemetryEnabled?: boolean;
  outboundHosts?: string[];
}

export class VetoCluster extends Construct {
  public readonly namespace: string;

  constructor(scope: Construct, id: string, props: VetoClusterProps) {
    super(scope, id);

    this.namespace = props.namespace ?? 'veto-system';
    const chartVersion = props.chartVersion ?? '0.1.0';
    const operatorDigest = props.operatorDigest ?? 'sha256:0000000000000000000000000000000000000000000000000000000000000000';
    const serverDigest = props.serverDigest ?? 'sha256:0000000000000000000000000000000000000000000000000000000000000000';
    const dashboardDigest = props.dashboardDigest ?? 'sha256:0000000000000000000000000000000000000000000000000000000000000000';
    const outboundHosts = props.outboundHosts ?? ['ghcr.io', 'license.veto.so', 'telemetry.veto.so'];

    if (props.cluster) {
      props.cluster.addHelmChart('VetoOperator', {
        chart: 'veto-operator',
        repository: 'oci://ghcr.io/plawio/charts',
        release: 'veto',
        namespace: this.namespace,
        version: chartVersion,
        createNamespace: true,
        values: {
          license: props.license,
          images: {
            operator: { digest: operatorDigest },
            server: { digest: serverDigest },
            dashboard: { digest: dashboardDigest },
          },
          telemetry: { enabled: props.telemetryEnabled ?? false },
          networkPolicy: { fqdn: { allowedNames: outboundHosts } },
        },
      });
    }

    new CfnOutput(this, 'VetoNamespace', { value: this.namespace });
    new CfnOutput(this, 'VetoBoundary', {
      value: 'Customer policy, decisions, tool args, identities, Slack content, prompts, env vars, and secrets remain in the customer AWS account; no Plaw cross-account IAM is created.',
    });
  }
}
