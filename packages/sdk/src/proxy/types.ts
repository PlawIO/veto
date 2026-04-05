/**
 * Type definitions for veto intercept proxy.
 *
 * @module proxy/types
 */

export interface ProxyConfig {
  /** Port for the local proxy to listen on. Default: 8080 */
  port: number;
  /** Upstream target URL. Default: https://api.openai.com */
  target: string;
  /** Max bytes to buffer before giving up and flushing. Default: 1MB */
  maxBufferBytes: number;
  /** Path to veto config directory. Default: ./veto */
  configDir: string;
}
