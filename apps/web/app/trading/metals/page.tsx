'use client';

import { NonCryptoLayout } from '@/components/trading/NonCryptoLayout';

export default function MetalsPage() {
  return (
    <NonCryptoLayout
      tradingType="metals"
      assetTypes={['commodity']}
      symbolFilter={(s) => s === 'XAU/USD' || s === 'XAG/USD'}
      proxyNote="Display shows XAU/USD and XAG/USD. Paper orders execute via GLD and SLV on Alpaca."
    />
  );
}
