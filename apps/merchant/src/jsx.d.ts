/**
 * React 19 removed the global JSX namespace; our components annotate returns
 * as JSX.Element (matching the codebase style). Re-expose it minimally.
 */

import type { ReactElement } from 'react';

declare global {
  namespace JSX {
    type Element = ReactElement;
  }
}

export {};
