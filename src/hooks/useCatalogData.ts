import { useEffect, useState } from 'react';
import { fetchJSON } from '../lib/apiClient';
import type { CatalogCardDTO, CatalogNobleDTO } from '../types';

export function useCatalogData(onError: (message: string) => void) {
  const [catalogCards, setCatalogCards] = useState<CatalogCardDTO[]>([]);
  const [catalogNobles, setCatalogNobles] = useState<CatalogNobleDTO[]>([]);

  useEffect(() => {
    void (async () => {
      try {
        const cards = await fetchJSON<CatalogCardDTO[]>('/api/cards');
        const nobles = await fetchJSON<CatalogNobleDTO[]>('/api/nobles');
        setCatalogCards(cards);
        setCatalogNobles(nobles);
      } catch (err) {
        onError((err as Error).message);
      }
    })();
  }, [onError]);

  return { catalogCards, catalogNobles };
}
