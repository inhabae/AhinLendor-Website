import type { BoardStateDTO, CardDTO, ColorCountsDTO, NobleDTO, TokenCountsDTO } from '../types';

const COLOR_MAP: Record<string, string> = {
  white: '#f7f5e9',
  blue: '#3e59ab',
  green: '#20805c',
  red: '#a64242',
  black: '#52422f',
  gold: '#d6b35f',
};

const REQ_ORDER: Array<'white' | 'blue' | 'green' | 'red' | 'black'> = ['white', 'blue', 'green', 'red', 'black'];
const TOKEN_ORDER: Array<'gold' | 'white' | 'blue' | 'green' | 'red' | 'black'> = ['gold', 'white', 'blue', 'green', 'red', 'black'];

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildBoardSvg(displayBoard: BoardStateDTO): { svg: string; width: number; height: number } {
  const rootStyle = getComputedStyle(document.documentElement);
  const bodyStyle = getComputedStyle(document.body);
  const pageBackground = bodyStyle.backgroundColor || 'rgb(17, 19, 23)';
  const panelFill = rootStyle.getPropertyValue('--panel').trim() || '#17181b';
  const boardFill = rootStyle.getPropertyValue('--board-surface-bg').trim() || '#2e343d';
  const textLight = rootStyle.color || '#eef2fb';
  const textMuted = '#9aa6bc';
  const width = 1880;
  const height = 1140;

  const renderToken = (x: number, y: number, color: keyof TokenCountsDTO, count: number): string => `
    <g transform="translate(${x} ${y})">
      <circle cx="30" cy="30" r="24" fill="${COLOR_MAP[color]}" stroke="#1e223080" stroke-width="3" />
      <text x="30" y="38" text-anchor="middle" font-size="26" font-weight="800" fill="${color === 'white' || color === 'gold' ? '#1f2430' : '#ffffff'}">${count}</text>
    </g>
  `;

  const renderCostRow = (cost: ColorCountsDTO, startX: number, y: number): string => REQ_ORDER
    .filter((color) => cost[color] > 0)
    .map((color, idx) => `
      <g transform="translate(${startX + idx * 34} ${y})">
        <circle cx="14" cy="14" r="14" fill="${COLOR_MAP[color]}" stroke="#1e223080" stroke-width="2" />
        <text x="14" y="19" text-anchor="middle" font-size="14" font-weight="800" fill="#ffffff">${cost[color]}</text>
      </g>
    `)
    .join('');

  const renderCard = (card: CardDTO, x: number, y: number, widthPx = 148, heightPx = 196): string => {
    const stroke = card.is_placeholder ? '#a2abb9' : '#0f1320';
    const fill = card.is_placeholder ? '#c9cfd8' : '#f3efe4';
    const banner = card.is_placeholder ? '#d9dee6' : COLOR_MAP[card.bonus_color];
    const label = card.is_placeholder ? '?' : `${card.points}`;
    return `
      <g transform="translate(${x} ${y})">
        <rect x="0" y="0" width="${widthPx}" height="${heightPx}" rx="14" fill="${fill}" stroke="${stroke}" stroke-width="3" />
        <rect x="0" y="0" width="${widthPx}" height="42" rx="14" fill="${banner}" />
        <text x="18" y="30" font-size="28" font-weight="900" fill="${card.is_placeholder || card.bonus_color === 'white' ? '#1f2430' : '#ffffff'}">${label}</text>
        ${card.is_placeholder ? '<text x="74" y="112" text-anchor="middle" font-size="72" font-weight="800" fill="#6b7380">?</text>' : renderCostRow(card.cost, 18, 150)}
      </g>
    `;
  };

  const renderNoble = (noble: NobleDTO | null, x: number, y: number): string => {
    if (!noble) {
      return `<rect x="${x}" y="${y}" width="132" height="100" rx="14" fill="#242a33" opacity="0.35" />`;
    }
    return `
      <g transform="translate(${x} ${y})">
        <rect x="0" y="0" width="132" height="100" rx="14" fill="#ece2c6" stroke="#5f4b2b" stroke-width="3" />
        <text x="18" y="28" font-size="26" font-weight="900" fill="#2b2111">${noble.points}</text>
        ${renderCostRow(noble.requirements, 14, 52)}
      </g>
    `;
  };

  const renderPlayer = (player: BoardStateDTO['players'][number], x: number, y: number): string => `
    <g transform="translate(${x} ${y})">
      <rect x="0" y="0" width="360" height="410" rx="18" fill="${panelFill}" stroke="rgba(255,255,255,0.08)" stroke-width="2" />
      <text x="24" y="38" font-size="28" font-weight="800" fill="${textLight}">${escapeXml(player.display_name)}</text>
      <text x="300" y="38" font-size="24" font-weight="800" fill="${textLight}">${player.points}★</text>
      <text x="24" y="76" font-size="18" font-weight="700" fill="${textMuted}">Tokens</text>
      ${TOKEN_ORDER.map((color, idx) => renderToken(18 + (idx % 3) * 106, 94 + Math.floor(idx / 3) * 76, color, player.tokens[color])).join('')}
      <text x="24" y="264" font-size="18" font-weight="700" fill="${textMuted}">Bonuses</text>
      ${REQ_ORDER.map((color, idx) => renderToken(18 + idx * 66, 280, color, player.bonuses[color])).join('')}
      <text x="24" y="388" font-size="18" font-weight="700" fill="${textMuted}">Reserved ${player.reserved_total}/3</text>
      ${Array.from({ length: 3 }, (_, idx) => renderCard(
        player.reserved_public.find((card) => card.slot === idx) ?? {
          points: 0,
          bonus_color: 'white',
          cost: { white: 0, blue: 0, green: 0, red: 0, black: 0 },
          source: 'reserved_public',
          slot: idx,
          is_placeholder: true,
        },
        18 + idx * 112,
        404,
        100,
        132,
      )).join('')}
    </g>
  `;

  const nobleBySlot = new Map((displayBoard.nobles ?? []).map((noble) => [noble.slot ?? -1, noble]));
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <rect width="${width}" height="${height}" fill="${pageBackground}" />
      ${renderPlayer(displayBoard.players[0], 40, 70)}
      ${renderPlayer(displayBoard.players[1], 40, 560)}
      <g transform="translate(440 60)">
        <rect x="0" y="0" width="1380" height="920" rx="26" fill="${boardFill}" />
        <g transform="translate(84 44)">
          ${[0, 1, 2].map((slot) => renderNoble(nobleBySlot.get(slot) ?? null, slot * 170, 0)).join('')}
        </g>
        <g transform="translate(680 56)">
          ${TOKEN_ORDER.map((color, idx) => renderToken(idx * 98, 0, color, displayBoard.bank[color])).join('')}
        </g>
        ${displayBoard.tiers.map((tier, rowIdx) => `
          <g transform="translate(72 ${188 + rowIdx * 238})">
            <rect x="0" y="0" width="118" height="196" rx="18" fill="#20252d" />
            <text x="59" y="82" text-anchor="middle" font-size="52" font-weight="900" fill="${textLight}">${tier.tier}</text>
            <text x="59" y="126" text-anchor="middle" font-size="26" font-weight="700" fill="${textMuted}">${tier.deck_count}</text>
            ${Array.from({ length: 4 }, (_, slot) => renderCard(
              tier.cards.find((card) => card.slot === slot) ?? {
                points: 0,
                bonus_color: 'white',
                cost: { white: 0, blue: 0, green: 0, red: 0, black: 0 },
                source: 'faceup',
                tier: tier.tier,
                slot,
                is_placeholder: true,
              },
              156 + slot * 272,
              0,
            )).join('')}
          </g>
        `).join('')}
      </g>
    </svg>
  `;

  return { svg, width, height };
}

function downloadBlob(blob: Blob, timestamp: string, extension: 'png' | 'svg'): void {
  const downloadUrl = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = downloadUrl;
    anchor.download = `splendor-board-${timestamp}.${extension}`;
    anchor.click();
  } finally {
    URL.revokeObjectURL(downloadUrl);
  }
}

function rasterizeSvgToPng(svg: string, width: number, height: number): Promise<Blob> {
  const scale = Math.max(2, Math.ceil(window.devicePixelRatio || 1));
  const canvas = document.createElement('canvas');
  canvas.width = width * scale;
  canvas.height = height * scale;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return Promise.reject(new Error('Canvas export is unavailable.'));
  }

  return new Promise<Blob>((resolve, reject) => {
    const svgBlob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const objectUrl = URL.createObjectURL(svgBlob);
    const image = new Image();
    image.onload = () => {
      try {
        ctx.scale(scale, scale);
        ctx.drawImage(image, 0, 0, width, height);
        canvas.toBlob((blob) => {
          URL.revokeObjectURL(objectUrl);
          if (blob) {
            resolve(blob);
          } else {
            reject(new Error('Failed to encode board image.'));
          }
        }, 'image/png');
      } catch (error) {
        URL.revokeObjectURL(objectUrl);
        reject(error);
      }
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('Failed to rasterize board SVG.'));
    };
    image.src = objectUrl;
  });
}

export async function downloadBoardImage(displayBoard: BoardStateDTO): Promise<void> {
  const { svg, width, height } = buildBoardSvg(displayBoard);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

  try {
    const pngBlob = await rasterizeSvgToPng(svg, width, height);
    downloadBlob(pngBlob, timestamp, 'png');
  } catch {
    const svgBlob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    downloadBlob(svgBlob, timestamp, 'svg');
  }
}
