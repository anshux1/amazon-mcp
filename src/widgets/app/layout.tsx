'use client';

import type { ReactNode } from 'react';
import { WidgetLayout } from '@nitrostack/widgets';
import './globals.css';

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <WidgetLayout>{children}</WidgetLayout>
      </body>
    </html>
  );
}
