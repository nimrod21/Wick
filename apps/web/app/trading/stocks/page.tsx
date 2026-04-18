'use client';

import { NonCryptoLayout } from '@/components/trading/NonCryptoLayout';

export default function StocksPage() {
  return (
    <NonCryptoLayout
      tradingType="stocks"
      assetTypes={['stock']}
      proxyNote="US equities. Paper orders execute via Alpaca."
    />
  );
}
