'use client';

import { useEffect, useState } from 'react';

const formatter = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

export function LocalClock() {
  const [time, setTime] = useState<string>('');

  useEffect(() => {
    setTime(formatter.format(new Date()));
    const id = setInterval(() => setTime(formatter.format(new Date())), 1000);
    return () => clearInterval(id);
  }, []);

  return <span className="vt-font text-neon-cyan text-lg" suppressHydrationWarning>{time}</span>;
}
