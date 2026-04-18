'use client';

import { useEventStream } from '@/lib/sse';

const KEYFRAMES = `
@keyframes wsskillStatusBlink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}
`;

export function StatusDot() {
  const { connected } = useEventStream(['indicator']);

  const color = connected ? 'var(--neon-cyan)' : 'var(--neon-amber)';
  const title = connected ? 'stream: connected' : 'stream: disconnected';

  return (
    <>
      {/* Inline keyframes so we don't depend on globals.css having this animation. */}
      <style dangerouslySetInnerHTML={{ __html: KEYFRAMES }} />
      <span
        title={title}
        aria-label={title}
        style={{
          width: 8,
          height: 8,
          display: 'inline-block',
          backgroundColor: color,
          animation: connected ? 'wsskillStatusBlink 1.2s ease-in-out infinite' : undefined,
        }}
      />
    </>
  );
}
