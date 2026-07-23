import { useMemo } from 'react';
import type { BoardStateDTO, CatalogCardDTO, CatalogNobleDTO } from '../types';

const COLOR_ORDER: CatalogCardDTO['bonus_color'][] = ['white', 'blue', 'green', 'red', 'black'];

export function useCatalogIndex(catalogCards: CatalogCardDTO[], catalogNobles: CatalogNobleDTO[]) {
  const cardsByTier = useMemo(() => {
    return catalogCards.reduce<Record<number, CatalogCardDTO[]>>((acc, card) => {
      if (!acc[card.tier]) {
        acc[card.tier] = [];
      }
      acc[card.tier].push(card);
      return acc;
    }, {});
  }, [catalogCards]);

  const cardsByTierAndColor = useMemo(() => {
    const grouped: Record<number, Record<CatalogCardDTO['bonus_color'], CatalogCardDTO[]>> = {
      1: { white: [], blue: [], green: [], red: [], black: [] },
      2: { white: [], blue: [], green: [], red: [], black: [] },
      3: { white: [], blue: [], green: [], red: [], black: [] },
    };
    for (const card of catalogCards) {
      grouped[card.tier][card.bonus_color].push(card);
    }
    for (const tier of [1, 2, 3] as const) {
      for (const color of COLOR_ORDER) {
        grouped[tier][color].sort((a, b) => {
          const aTotal = a.cost.white + a.cost.blue + a.cost.green + a.cost.red + a.cost.black;
          const bTotal = b.cost.white + b.cost.blue + b.cost.green + b.cost.red + b.cost.black;
          if (aTotal !== bTotal) return aTotal - bTotal;
          if (a.points !== b.points) return a.points - b.points;
          return a.id - b.id;
        });
      }
    }
    return grouped;
  }, [catalogCards]);

  const groupedCatalogNobles = useMemo(() => {
    const groups = {
      three: [] as CatalogNobleDTO[],
      four: [] as CatalogNobleDTO[],
    };
    for (const noble of catalogNobles) {
      const reqs = COLOR_ORDER.map((color) => noble.requirements[color]).filter((count) => count > 0);
      if (reqs.length === 3 && reqs.every((count) => count === 3)) {
        groups.three.push(noble);
      } else if (reqs.length === 2 && reqs.every((count) => count === 4)) {
        groups.four.push(noble);
      }
    }
    return groups;
  }, [catalogNobles]);

  function cardOptionLabel(card: CatalogCardDTO): string {
    const cost = Object.entries(card.cost)
      .filter(([, count]) => count > 0)
      .map(([color, count]) => `${count}${color[0].toUpperCase()}`)
      .join(' ');
    return `#${card.id} ${card.bonus_color} ${card.points}pt${cost ? ` | ${cost}` : ''}`;
  }

  function nobleOptionLabel(noble: CatalogNobleDTO): string {
    const reqs = Object.entries(noble.requirements)
      .filter(([, count]) => count > 0)
      .map(([color, count]) => `${count}${color[0].toUpperCase()}`)
      .join(' ');
    return `#${noble.id} ${noble.points}pt${reqs ? ` | ${reqs}` : ''}`;
  }

  function findCatalogCard(card: BoardStateDTO['tiers'][number]['cards'][number]): CatalogCardDTO | null {
    const matches = catalogCards.filter((candidate) =>
      (card.tier == null || candidate.tier === card.tier) &&
      candidate.points === card.points &&
      candidate.bonus_color === card.bonus_color &&
      candidate.cost.white === card.cost.white &&
      candidate.cost.blue === card.cost.blue &&
      candidate.cost.green === card.cost.green &&
      candidate.cost.red === card.cost.red &&
      candidate.cost.black === card.cost.black
    );
    return matches[0] ?? null;
  }

  function findCatalogCardId(card: BoardStateDTO['tiers'][number]['cards'][number]): number | null {
    return findCatalogCard(card)?.id ?? null;
  }

  function findCatalogNobleId(noble: BoardStateDTO['nobles'][number]): number | null {
    const match = catalogNobles.find((candidate) =>
      candidate.points === noble.points &&
      candidate.requirements.white === noble.requirements.white &&
      candidate.requirements.blue === noble.requirements.blue &&
      candidate.requirements.green === noble.requirements.green &&
      candidate.requirements.red === noble.requirements.red &&
      candidate.requirements.black === noble.requirements.black
    );
    return match?.id ?? null;
  }

  return {
    cardsByTier,
    cardsByTierAndColor,
    groupedCatalogNobles,
    cardOptionLabel,
    nobleOptionLabel,
    findCatalogCard,
    findCatalogCardId,
    findCatalogNobleId,
  };
}
