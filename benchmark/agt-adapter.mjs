export function getAgtComparison() {
  return {
    runtime: 'AGT',
    source: 'published',
    reproduced: false,
    methodology_note: 'Published comparison numbers from the charter; not reproduced by this CI harness.',
    workloads: [
      {
        name: 'policy eval latency per rule',
        published_latency_ms_per_rule: 0.012,
        source: 'published',
        reproduced: false,
      },
      {
        name: 'throughput at 50 concurrent agents',
        published_throughput_ops_sec: 35000,
        concurrency: 50,
        source: 'published',
        reproduced: false,
      },
    ],
  };
}
