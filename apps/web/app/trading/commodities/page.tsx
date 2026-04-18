'use client';

import { NonCryptoLayout } from '@/components/trading/NonCryptoLayout';

export default function CommoditiesPage() {
  return (
    <NonCryptoLayout
      tradingType="commodities"
      assetTypes={['commodity']}
      symbolFilter={(s) => s === 'WTI/USD'}
      proxyNote="Display shows WTI/USD crude oil. Paper orders execute via USO on Alpaca."
    />
  );
}
