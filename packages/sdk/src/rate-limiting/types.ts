export interface RateLimitEntry {
  /** Scope of the rate limit */
  scope: 'agent' | 'user' | 'session' | 'global';
  /** Maximum calls allowed in the window */
  max_calls: number;
  /** Window size in seconds */
  window_seconds: number;
}
