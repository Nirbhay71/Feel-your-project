// Feel's Next.js setup, as a user would write it.
import { withFeel } from '@feel-dev/next';

export default withFeel(
  { agentRules: false }, // don't let next dev write AGENTS.md / CLAUDE.md here
  { database: process.env.DATABASE_URL, projectRoot: '.' },
);
