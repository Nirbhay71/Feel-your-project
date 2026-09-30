// Types for @feel-dev/next (the package itself is plain JavaScript).
import type { NextConfig } from 'next';

type Phase = string;
type ConfigContext = { defaultConfig: NextConfig };
type ConfigInput = NextConfig | ((phase: Phase, context: ConfigContext) => NextConfig | Promise<NextConfig>);

export interface FeelOptions {
  /** Connection string for the table view (Postgres). */
  database?: string;
  /** Folder with frontend and backend, if not the nearest .git. */
  projectRoot?: string;
  /** The Next project (default: the folder next runs in). */
  root?: string;
  /** Extra host names that may reach the agent (default: your allowedDevOrigins). */
  allowedHosts?: string[];
  /** Client IP addresses besides this machine that may use the agent (default: none). */
  allowedAddresses?: string[];
}

/** Wraps your Next config; returns a config function (put it outermost). */
export function withFeel(nextConfig?: ConfigInput, options?: FeelOptions): (phase: Phase, context: ConfigContext) => Promise<NextConfig>;
export default withFeel;
